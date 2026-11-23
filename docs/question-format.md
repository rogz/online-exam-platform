# Question bank CSV format (Exam Wizard)

Use this format to write questions that import with **Question bank → Import CSV**.
A ready-made example: [`public/assets/sample-questions.csv`](../public/assets/sample-questions.csv)
(also downloadable on the site: `/assets/sample-questions.csv`).

## Columns

The first row holds the column names. Column order doesn't matter. `*` = required.

| Column | What to put | Example |
|---|---|---|
| `QuestionID` | Optional code. Importing a row with an ID that already exists **updates** that question instead of adding a copy. | `PSA-LP-01` |
| `Type` * | `MC` multiple choice, `TF` true/false, `FIB` fill in the blank, `ESSAY` | `MC` |
| `Question` * | The question text. For `FIB`, put `____` (4 underscores) where the blank goes; several blanks are allowed. | `V = I × ____` · `V = ____ V and I = ____ A` |
| `Choices` | `MC` only: the choices separated by ` \| ` (space, bar, space). Leave empty for other types. | `Volt \| Ohm \| Ampere \| Watt` |
| `Answer` * | `MC`: the **letter** of the correct choice (`A`, `B`, `C`…). `TF`: `TRUE` or `FALSE`. `FIB`: accepted answers separated by ` \| ` (capital letters don't matter); for a calculated number, a range: `122.1-122.9 V`, `122.5 ± 0.4 V` or `122.5 ± 1%` (`+-` also works; any number inside counts, the unit is optional). **Several blanks:** one entry per blank, in order, separated by ` ; ` (e.g. `120 ± 1% V ; 5 ± 1% A`); each correct blank earns an equal share of the points. `ESSAY`: optional guide answer for the teacher. | `B` · `TRUE` · `R \| resistance` |
| `Points` | Points for the question; empty = 1. | `2` |
| `Topic` | Optional. Used for filtering and for picking random questions per topic. | `Inductance` |
| `Image` | Optional picture link starting with `https://` (Google Drive links must be shared publicly). | `https://…` |
| `Folder` | Optional folder path; folders are created if missing. Use `/` between levels. | `Power System Analysis/Line Parameters` |

## Rules for a clean import

- Save as **CSV UTF-8** (Excel: *File → Save As → CSV UTF-8*; Google Sheets: *File → Download → Comma-separated values*). UTF-8 keeps symbols like Ω, ρ, μ, ε₀, ×, ², ⁻⁸.
- Any field that contains a **comma** or a **double quote** must be wrapped in double quotes; double quotes inside it are written twice (`""`). Excel and Google Sheets do this automatically.
- `±` can be written `+-` (e.g. `122.5 +- 1%`); it works the same.
- Don't use `|` inside a choice or an accepted answer (it separates them).
- Rows with a problem are listed after importing; the other rows are still added.

## Example

```csv
QuestionID,Type,Question,Choices,Answer,Points,Topic,Folder
PSA-LP-01,MC,"For a conductor of resistivity ρ, length l and area A, the DC resistance is:",R = ρA / l | R = ρl / A | R = l / (ρA) | R = ρl² / A,B,1,Resistance,Power System Analysis/Line Parameters
PSA-LP-02,TF,Skin effect makes the AC resistance higher than the DC resistance.,,TRUE,1,Resistance,Power System Analysis/Line Parameters
PSA-LP-03,FIB,The GMR of a solid round conductor of radius r is ____ r.,,0.7788 | .7788,1,Inductance,Power System Analysis/Line Parameters
PSA-LP-05,FIB,"A 3-phase line delivers 10 MW at 0.8 power factor and 69 kV. The line current is I = ____ A and the reactive power is Q = ____ MVAR.",,104.6 ± 1% ; 7.5 ± 1%,2,Power,Power System Analysis/Line Parameters
PSA-LP-04,ESSAY,Explain why transmission lines are transposed.,,"To make the average inductance and capacitance of the three phases equal.",5,Inductance,Power System Analysis/Line Parameters
```

## When an AI writes a quiz in this format

- Write math between dollar signs so it is drawn properly: `$V_S$`, `$I_{L}$`, `$10^{-3}$`, `$\Omega$`, `$\sqrt{3}$`,
  `$\frac{P}{\sqrt{3}V}$`, `$\cos\theta$`, `$30^\circ$`. A plain dollar sign is `\$`. Keep the `Answer` column plain text
  (numbers, words, ranges like `122.5 ± 1%`), never math.
- With several blanks, write each part so it becomes a clear answer line: `Find (a) the sending voltage $V_S$ = ____ kV;
  (b) the sending current $I_S$ = ____ A.` The words before each blank are its label and the word right after it is its unit.

- Give every question a `QuestionID` with a short course prefix and a number (`PSA-LP-01`, `PSA-LP-02`, …), so a corrected file can be re-imported to **update** the same questions.
- Multiple choice: 4 choices, one clearly correct; spread the correct letters evenly over A–D; plausible wrong choices (common mistakes, wrong units, off by a factor).
- For calculation questions, work the answer out step by step and double-check the numbers and units before writing the row; state the constants used (e.g. ε₀ = 8.854 × 10⁻¹² F/m, GMR = 0.7788 r) in the question when the answer depends on them.
- Fill-in-the-blank calculations: give the answer as a range, normally ± 1% of the worked-out value (e.g. `122.5 ± 1% V`), so rounding along the way still counts; put the unit wanted in the question.
- A calculation with two or three results (e.g. current **and** power) can be one FIB question with several blanks: `I = ____ A and P = ____ W`, answer `10 ± 1% ; 2400 ± 1%` (one entry per blank, in order, separated by ` ; `). Give it enough points for the blanks (each blank earns an equal share). Keep the number of `____` and the number of `;`-separated entries the same.
- Use `Topic` for the sub-topics (so exams can pick e.g. 5 per topic) and one `Folder` for the whole set.
- Output the CSV only (header + rows), properly quoted, ready to save as `.csv`.
- Ask the teacher to review the answer key, or use **Preview → Check answers** on the site, before publishing.
