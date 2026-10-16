# gradescope-tampermonkey

Tampermonkey userscripts for Gradescope:

- [**Rubric Import/Export**](#rubric-importexport) (`gradescope-rubric-import.user.js`): import a question's rubric, or every rubric in an assignment, from a JSON file, and export it back out.
- [**Bubble Sheet Answer Key**](#bubble-sheet-answer-key) (`gradescope-bubble-sheet-key.user.js`): fill in a bubble sheet assignment's answer key from a CSV file, and export it back out.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. For each script you want, create a new script in Tampermonkey and paste in the `.user.js` file.

## Rubric Import/Export

### Status

Gradescope's rubric endpoints are undocumented. The script sends the same requests Gradescope's own pages were seen sending (October 2026). Gradescope can change them without notice; if an import starts failing, set `DEBUG = true` at the top of the script, repeat the action by hand in Gradescope, and use **Copy debug log** to see what the page sends now.

### Use

Open either the grading view (Grade Submissions, then a question) or the assignment's Create Rubric page. Each rubric's row of buttons (Add Rubric Item, Create Group, Import...) gains two more:

- **Import JSON**: choose a file, check the preview, optionally tick "Replace existing rubric", then Import. The file is fully validated before any request is made, and the page reloads when the import finishes.
- **Export JSON**: downloads that question's rubric in the format below, including edits made since the page loaded.

On the Create Rubric page every question has its own pair of buttons, and the action bar at the bottom gains two more, before **Manage Scans**, for the whole assignment:

- **Import All JSON**: like Import JSON, but takes an [assignment file](#assignment-file) and imports into every question it names. The preview lists each question's rubric, the questions the file leaves alone, and any title that differs from the assignment's. "Replace existing rubric" applies to every question in the file, and you confirm the total number of deletions once.
- **Export All JSON**: downloads every question's rubric as one assignment file.

The buttons are attached to Gradescope's own markup, so if Gradescope restyles those rows they may stop appearing.

### JSON format

Field names follow Gradescope's own. See `examples/rubric.example.json`.

```json
{
  "scoring_type": "negative",
  "floor": true,
  "ceiling": true,
  "rubric_items": [
    { "description": "Correct", "weight": 0 }
  ],
  "rubric_item_groups": [
    {
      "description": "Convergence justification",
      "mutually_exclusive": true,
      "rubric_items": [
        { "description": "Complete", "weight": 0 }
      ]
    }
  ]
}
```

- `scoring_type` (`"positive"` or `"negative"`), `floor` and `ceiling` are optional. Leave one out to keep the question's current setting.
- `description` is plain text; Markdown and LaTeX pass through. Gradescope's math delimiter is `$$…$$`.
- `mutually_exclusive: true` is Gradescope's "select one" style. Groups cannot be nested, and each needs at least one item.
- Ungrouped items are created first, then groups, each in file order. To interleave them, give every ungrouped item and every group a numeric `position`; they are then created in that order. Exports of a rubric with both include `position`.
- Gradescope's flat form is accepted too: top-level items with a `group_id` matching a group's `id`.

### Assignment file

A list of rubrics in the format above, each with the number of the question it belongs to. See `examples/rubric-assignment.example.json`.

```json
{
  "questions": [
    { "question": "1", "title": "Integration by substitution", "rubric_items": [ ... ] },
    { "question": "2.1", "title": "Series convergence", "rubric_items": [ ... ], "rubric_item_groups": [ ... ] }
  ]
}
```

- `question` is the question's number as Gradescope shows it (`"1"`, `"2.1"`), so a file exported from one assignment can be imported into another with the same numbering. Every number must exist in the assignment, and each may appear once.
- `title` is optional and only checked: if it differs from the question's title, the preview warns, but the import goes ahead.
- Questions not in the file are left alone.
- The whole file is validated before any request is made. If an import fails partway, it stops at that question; earlier questions are already done.

### Caveats

- **Replace deletes rubric items.** If an item has been applied to submissions, deleting it changes those grades.
- Do not replace the pre-loaded Correct/Incorrect items on auto-graded Online Assignment questions; that breaks their auto-grading.
- Rubric item groups need an Institutional license.
- If rubric permissions lock editing for your role, the import stops at the first rejected request.
- If an import fails partway, it stops and lists what was done. There is no rollback.

## Bubble Sheet Answer Key

Replaces [gradescope-bubbler](https://github.com/nyumathclinic/gradescope-bubbler), an archived Python app originally by Julius Damarackas. Its CSV files work here unchanged.

### Use

Open a bubble sheet assignment's answer-key editor (Edit Answer Key; the URL ends in `bubble_sheet_answer_key/edit`). The action bar gains two buttons before **Save Answer Key**:

- **Fill from CSV**: choose a CSV file for each version you want to fill in (up to five; versions without a file are left alone), check the preview, then click Fill. Every file, and whether every question and bubble it names is on that version's page, is checked before anything is clicked. Bubbles not in a key are unchecked. With more than one version, the script then switches back through each one and checks that its bubbles still match its key.
- **Export CSV**: downloads the version currently shown, as `answer-key-version-a.csv` and so on, in the format below.

The script clicks the editor the way you would and **never saves**. When it finishes, review each version and click Save Answer Key. Leaving the page without saving discards the changes.

### CSV format

The first row is a header. Columns can appear in any order. See `examples/answer-key.example.csv`.

| Column | Required | Meaning |
|--------|----------|---------|
| `Question` | yes | Question number, as Gradescope numbers it (`1`, `2`, ...) |
| `Answers` (or `Answer`) | yes | Correct letter(s), A–E. Several letters mean several correct bubbles: `AC`, `A C`, or `"A,C"` |
| `Points` | no | Point value for the question, e.g. `2` or `2.5` |
| `Type` | no | Scoring type, exactly as the button reads in the question's settings (e.g. `Exact`) |

Leave `Points` or `Type` blank (or omit the column) to keep the question's current setting. Rows with a blank `Question` are skipped.

```csv
Question,Answers,Points,Type
1,B,2.0,Exact
2,D,2.0,Exact
4,AC,3.0,Exact
```

### Caveats

- Filling several versions switches between them in the version tabs. If the check afterwards finds that an earlier version lost its answers, Gradescope is discarding unsaved changes when you switch: fill in one version at a time, saving after each.
- The script relies on the editor's markup (the bubble checkboxes' IDs, the gear menu, the points field). If Gradescope changes it, filling stops with a timeout or "not on this page" message and nothing is saved. The markup is listed at the top of the script's "answer-key editor" and "Versions" sections.
- **Export** writes `Answers` and, where the page has it, `Points`. It doesn't write `Type`, so re-importing an export leaves scoring types unchanged. Questions with no bubble checked are left out.
