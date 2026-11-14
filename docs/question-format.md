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
| `Question` * | The question text. For `FIB`, put `____` (4 underscores) where the blank goes. | `V = I × ____` |
| `Choices` | `MC` only: the choices separated by ` \| ` (space, bar, space). Leave empty for other types. | `Volt \| Ohm \| Ampere \| Watt` |
| `Answer` * | `MC`: the **letter** of the correct choice (`A`, `B`, `C`…). `TF`: `TRUE` or `FALSE`. `FIB`: accepted answers separated by ` \| ` (capital letters don't matter). `ESSAY`: optional guide answer for the teacher. | `B` · `TRUE` · `R \| resistance` |
| `Points` | Points for the question; empty = 1. | `2` |
| `Topic` | Optional. Used for filtering and for picking random questions per topic. | `Inductance` |
| `Image` | Optional picture link starting with `https://` (Google Drive links must be shared publicly). | `https://…` |
| `Folder` | Optional folder path; folders are created if missing. Use `/` between levels. | `Power System Analysis/Line Parameters` |

## Rules for a clean import

- Save as **CSV UTF-8** (Excel: *File → Save As → CSV UTF-8*; Google Sheets: *File → Download → Comma-separated values*). UTF-8 keeps symbols like Ω, ρ, μ, ε₀, ×, ², ⁻⁸.
- Any field that contains a **comma** or a **double quote** must be wrapped in double quotes; double quotes inside it are written twice (`""`). Excel and Google Sheets do this automatically.
- Don't use `|` inside a choice or an accepted answer (it separates them).
- Rows with a problem are listed after importing; the other rows are still added.

## Example

```csv
QuestionID,Type,Question,Choices,Answer,Points,Topic,Folder
PSA-LP-01,MC,"For a conductor of resistivity ρ, length l and area A, the DC resistance is:",R = ρA / l | R = ρl / A | R = l / (ρA) | R = ρl² / A,B,1,Resistance,Power System Analysis/Line Parameters
PSA-LP-02,TF,Skin effect makes the AC resistance higher than the DC resistance.,,TRUE,1,Resistance,Power System Analysis/Line Parameters
PSA-LP-03,FIB,The GMR of a solid round conductor of radius r is ____ r.,,0.7788 | .7788,1,Inductance,Power System Analysis/Line Parameters
PSA-LP-04,ESSAY,Explain why transmission lines are transposed.,,"To make the average inductance and capacitance of the three phases equal.",5,Inductance,Power System Analysis/Line Parameters
```

## When an AI writes a quiz in this format

- Give every question a `QuestionID` with a short course prefix and a number (`PSA-LP-01`, `PSA-LP-02`, …), so a corrected file can be re-imported to **update** the same questions.
- Multiple choice: 4 choices, one clearly correct; spread the correct letters evenly over A–D; plausible wrong choices (common mistakes, wrong units, off by a factor).
- For calculation questions, work the answer out step by step and double-check the numbers and units before writing the row; state the constants used (e.g. ε₀ = 8.854 × 10⁻¹² F/m, GMR = 0.7788 r) in the question when the answer depends on them.
- Use `Topic` for the sub-topics (so exams can pick e.g. 5 per topic) and one `Folder` for the whole set.
- Output the CSV only (header + rows), properly quoted, ready to save as `.csv`.
- Ask the teacher to review the answer key, or use **Preview → Check answers** on the site, before publishing.
