/* Camera monitoring for the exam page.
 * Runs in the student's browser. No video is recorded or uploaded; when the camera flags something,
 * the exam page may save one small still picture (snapshot()) as proof for the teacher.
 * Uses Google MediaPipe to detect faces and (optionally) mobile phones.
 *
 * Status values reported to the page:
 *   OFF             camera not started
 *   LOADING         camera on, detector still loading
 *   OK              exactly one face, nothing blocking
 *   NO_FACE         no face visible
 *   CAMERA_BLOCKED  image is dark or blank (lens covered)
 *   MULTIPLE_FACES  more than one face
 *   PHONE_DETECTED  a mobile phone is visible
 *   CAMERA_OFF      the camera stopped (unplugged, permission revoked)
 *   NO_HANDS        hands mode: no hand visible
 *
 * Two modes: 'face' (the usual: one face in view) and 'hands' (Strict exams: the camera shows the hands and desk;
 * the exam page switches back to 'face' for a moment when it asks the student to show their face).
 */
window.ExamCamera = (function () {
  'use strict';

  const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1';
  const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
  const PHONE_MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite';
  const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
  // camera software that can show a recorded video instead of the real camera
  const VIRTUAL = /\b(obs|virtual|manycam|xsplit|snap camera|splitcam|youcam|e2esoft|vcam|webcamoid|fake|dummy|mmhmm|camtwist|nvidia broadcast|chromacam|xsplit)\b/i;
  const CHECK_MS = 500;        // face check interval
  const PHONE_CHECK_MS = 1500; // phone/person check interval (heavier model)
  const HEAD_FRESH_MS = 2500;   // how long a "person seen" result counts when the face is not visible

  let stream = null;
  let video = null;
  let faceDetector = null;
  let phoneDetector = null;
  let handDetector = null;
  let mode = 'face';
  let hands = { count: 0, motion: 0, at: 0 };
  let lastTips = null;
  let deviceId = null;
  let timer = null;
  let onStatus = () => {};
  let status = 'OFF';
  let since = 0;
  let phoneSeen = false;
  let personSeen = 0;          // time a person (head and shoulders) was last seen
  let headOk = false;          // during the exam: a visible head counts as present (e.g. looking down to write)
  let watchPhones = false;
  let lastPhoneCheck = 0;
  let lastTs = 0;
  const probe = document.createElement('canvas');
  probe.width = 32; probe.height = 24;
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });

  function friendlyError(err) {
    const n = err && err.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') {
      return 'Camera permission was blocked. Click the camera icon in the address bar, choose "Allow", then click "Turn on camera" again.';
    }
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No camera was found. This exam requires a webcam.';
    if (n === 'NotReadableError' || n === 'AbortError') return 'The camera is being used by another app (for example Zoom or Teams). Close that app and try again.';
    return 'Face detection could not be loaded. Check your internet connection and reload the page.';
  }

  async function openStream() {
    stream = await navigator.mediaDevices.getUserMedia({
      video: Object.assign({ width: { ideal: 640 }, height: { ideal: 480 } }, deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
      audio: false,
    });
    stream.getVideoTracks().forEach((t) => t.addEventListener('ended', () => setStatus('CAMERA_OFF')));
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
  }

  /** Starts the camera and loads the detectors. Throws an Error with a friendly message. */
  async function start(videoEl, options) {
    video = videoEl;
    onStatus = options.onStatus || onStatus;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw Object.assign(new Error('no media'), { name: 'NotFoundError' });
      }
      if (!stream || !stream.active) await openStream();
      setStatus('LOADING');
      if (!faceDetector) {
        const vision = await import(MP_BASE + '/vision_bundle.mjs');
        const files = await vision.FilesetResolver.forVisionTasks(MP_BASE + '/wasm');
        faceDetector = await vision.FaceDetector.createFromOptions(files, {
          baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'CPU' },
          runningMode: 'VIDEO',
          minDetectionConfidence: 0.6,
        });
        watchPhones = !!options.phoneDetection;
        if (options.handsMode && !handDetector) {
          handDetector = await vision.HandLandmarker.createFromOptions(files, {
            baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'CPU' },
            runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5,
          });
        }
        if (options.phoneDetection || options.headDetection) {
          phoneDetector = await vision.ObjectDetector.createFromOptions(files, {
            baseOptions: { modelAssetPath: PHONE_MODEL, delegate: 'CPU' },
            runningMode: 'VIDEO',
            scoreThreshold: 0.4,
            categoryAllowlist: ['cell phone', 'person'],
            maxResults: 4,
          });
        }
      }
    } catch (err) {
      const e = new Error(friendlyError(err));
      e.cause = err;
      setStatus('OFF');
      throw e;
    }
    clearInterval(timer);
    timer = setInterval(check, CHECK_MS);
    check();
  }

  /** Turns the camera back on after it stopped (no new permission prompt if already allowed). */
  async function restart() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    await openStream();
    since = Date.now();
    check();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    setStatus('OFF');
  }

  /** Shows the same camera picture in another <video> (e.g. inside the warning box). */
  /** A small, heavily compressed JPEG of the current camera frame with a label and the time burned in. */
  /** A small JPEG of the camera image with a label and the time. opts.small: 240 px wide, grayscale, more compressed (≈3–5 KB). */
  function snapshot(label, opts) {
    if (!video || !video.videoWidth) return null;
    const small = !!(opts && opts.small), w = small ? 240 : 320;
    const c = document.createElement('canvas');
    c.width = w; c.height = Math.round(w * video.videoHeight / video.videoWidth) || Math.round(w * 0.75);
    const g = c.getContext('2d');
    g.drawImage(video, 0, 0, c.width, c.height);
    if (small) {
      const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
      for (let i = 0; i < d.length; i += 4) { const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; d[i] = d[i + 1] = d[i + 2] = y; }
      g.putImageData(img, 0, 0);
    }
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, c.height - 16, c.width, 16);
    g.fillStyle = '#fff'; g.font = (small ? '10' : '11') + 'px sans-serif';
    g.fillText(String(label || '').slice(0, 30) + '  ' + new Date().toLocaleString(), 4, c.height - 4);
    return c.toDataURL('image/jpeg', small ? 0.35 : 0.4);
  }

  function mirrorTo(otherVideo) {
    if (!stream) return;
    otherVideo.srcObject = stream;
    otherVideo.muted = true;
    otherVideo.playsInline = true;
    otherVideo.play().catch(() => {});
  }

  /** Keeps the main preview playing after it was moved in the page. */
  function resume() {
    if (video && video.paused) video.play().catch(() => {});
  }

  function isBlocked() {
    probeCtx.drawImage(video, 0, 0, probe.width, probe.height);
    const d = probeCtx.getImageData(0, 0, probe.width, probe.height).data;
    let sum = 0, sumSq = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      sum += y; sumSq += y * y;
    }
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    return mean < 18 || sd < 5; // very dark, or one flat colour (finger, tape, cover)
  }

  function check() {
    if (!stream || !stream.active || stream.getVideoTracks().every((t) => t.readyState === 'ended')) {
      if (status !== 'OFF') setStatus('CAMERA_OFF');
      return;
    }
    if (!faceDetector || !video || video.readyState < 2) return;
    let ts = Math.round(performance.now());
    if (ts <= lastTs) ts = lastTs + 1;
    lastTs = ts;
    try {
      let next;
      if (isBlocked()) {
        next = 'CAMERA_BLOCKED';
      } else {
        let faces = 0;
        if (mode === 'hands' && handDetector) {
          const r = handDetector.detectForVideo(video, ts);
          const lm = r.landmarks || [];
          const tips = lm.map((h) => [4, 8, 12, 16, 20].map((i) => h[i]));
          let motion = 0;
          if (lastTips && tips.length && lastTips.length) {
            const a = tips[0], b = lastTips[0]; let d = 0;
            for (let i = 0; i < a.length; i++) d += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
            motion = d / a.length;
          }
          lastTips = tips.length ? tips : null;
          hands = { count: lm.length, motion, at: Date.now() };
        } else {
          faces = faceDetector.detectForVideo(video, ts).detections.length;
        }
        // Objects every 1.5 s; sooner when the face is gone, to check for a lowered head.
        if (phoneDetector && (ts - lastPhoneCheck >= PHONE_CHECK_MS || (faces === 0 && headOk && ts - lastPhoneCheck >= CHECK_MS))) {
          lastPhoneCheck = ts;
          const found = phoneDetector.detectForVideo(video, ts).detections.map((d) => d.categories[0] || {});
          phoneSeen = watchPhones && found.some((c) => c.categoryName === 'cell phone' && c.score >= 0.45);
          if (found.some((c) => c.categoryName === 'person' && c.score >= 0.5)) personSeen = Date.now();
        }
        const headVisible = headOk && Date.now() - personSeen < HEAD_FRESH_MS;
        next = mode === 'hands'
          ? (phoneSeen ? 'PHONE_DETECTED' : hands.count === 0 ? 'NO_HANDS' : 'OK')
          : faces > 1 ? 'MULTIPLE_FACES' : faces === 0 && !headVisible ? 'NO_FACE' : phoneSeen ? 'PHONE_DETECTED' : 'OK';
      }
      setStatus(next);
    } catch (e) {
      console.warn('face check failed', e);
    }
  }

  function setStatus(next) {
    if (next !== status) { status = next; since = Date.now(); }
    onStatus(status, Date.now() - since);
  }

  return {
    start, restart, stop, mirrorTo, resume, snapshot,
    /** 'face' or 'hands' (hands needs start() with handsMode). */
    setMode(m) { const next = m === 'hands' && handDetector ? 'hands' : 'face'; if (next !== mode) { mode = next; lastTips = null; since = Date.now(); check(); } },
    mode: () => mode,
    /** Hands mode: how many hands are visible and how much the fingertips moved since the last check (0 … about 0.1). */
    handInfo: () => Object.assign({}, hands),
    /** The camera's name, e.g. "HD WebCam" or "OBS Virtual Camera". */
    cameraName() { const t = stream && stream.getVideoTracks()[0]; return t ? t.label || '' : ''; },
    isVirtual(name) { return VIRTUAL.test(String(name === undefined ? (stream && stream.getVideoTracks()[0] || {}).label || '' : name)); },
    /** The cameras on this device (names are known once the camera was allowed). */
    async listCameras() { try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch (e) { return []; } },
    async useCamera(id) { deviceId = id || null; if (stream) { await restart(); } },
    currentDeviceId() { const t = stream && stream.getVideoTracks()[0]; return t && t.getSettings ? t.getSettings().deviceId || null : null; },
    /** Files the camera checker loads from the internet (kept in the browser for offline exams). */
    files: [MP_BASE + '/vision_bundle.mjs', MP_BASE + '/wasm/vision_wasm_internal.js', MP_BASE + '/wasm/vision_wasm_internal.wasm',
      MP_BASE + '/wasm/vision_wasm_nosimd_internal.js', MP_BASE + '/wasm/vision_wasm_nosimd_internal.wasm', FACE_MODEL, PHONE_MODEL],
    handFiles: [HAND_MODEL],
    /** During the exam, accept a visible head (looking down) as present. Before starting, a face is required. */
    allowHead(on) { headOk = !!on; },
    status: () => status,
    statusAge: () => Date.now() - since,
  };
})();
