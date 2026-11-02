# Starfish userscripts

- [**Progress Survey Filler**](#progress-survey-filler) (`progress-survey.user.js`): fill in a progress survey (each student's progress checkbox and comment) from a CSV file keyed by username.

To install, see the [top-level README](../README.md#install).

## Progress Survey Filler

### Use

Open a progress survey for a section (Students, then Progress Surveys; the URL ends in `#/survey/` and a number). The footer gains a **Fill from CSV** button before **Reset**.

1. Choose the section's CSV file. It is checked first; any problem is listed and nothing more happens until the file is fixed.
2. Click **Fill**. First the script matches students. The survey rows don't show usernames, so it reads each student's username off their hover card. Cards for students you've already hovered over are read straight away; for the rest, the script hovers over the name until the card is built. Leave the mouse still while it runs. A student whose card won't show is matched by the CSV's name column instead.

   The report lists CSV students not on the page, names that differ between the CSV and the page, students already marked differently (they are changed), and students on the page not in the CSV (they are left alone). If any matched student can't be filled in (for instance, Concerns with no comment), nothing is clicked.

   Then each matched student's progress box is checked, any other one is cleared, and the comment is typed in (opening Show Comments where needed). Afterwards the page is checked against the CSV.

The script **never saves or submits**. When it finishes, review the page, click Save, then Submit.

### CSV format

The first row is a header. Columns can appear in any order; others are ignored. See `examples/progress-survey.example.csv`.

| Column | Required | Meaning |
|--------|----------|---------|
| `Username` | yes | The student's NetID, as on their hover card |
| `Progress Indicator` | yes | `Strong`, `Satisfactory` or `Concerns`: the start of a checkbox's label, in any case |
| `Name (Last, First)` | no | Used to match a student whose hover card won't show, and to warn when it differs from the page |
| `Comments` | no | Comment for the checked box. Required for Concerns unless the survey already has one. Blank leaves any existing comment as it is |
| `Reason Code` | no | Ignored; the survey has no field for it |

```csv
Username,"Name (Last, First)",Progress Indicator,Comments,Reason Code
ss1234,"Student, Susie",Strong,"Excellent work on the first two exams.",
jd5678,"Doe, John",Satisfactory,,
```

### Caveats

- Usernames are read from the page and kept only in the page while it is open; nothing is sent anywhere.
- Only the students on the page are filled in. CSV students from another section are reported as "not on this page".
- The script relies on the survey's markup (the checkbox ids, the comments row, the hover card). If Starfish changes it, Fill stops with a timeout or the button doesn't appear, and nothing is saved. The markup is listed at the top of the script's "survey" section.
- If filling stops partway, the students marked ✓ are done. Click Reset to discard everything, or close the dialog and fill again: students already done are left as they are.
