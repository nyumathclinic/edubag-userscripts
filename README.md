# gradescope-tampermonkey

Tampermonkey userscripts for Gradescope:

- [**Rubric Import/Export**](#rubric-importexport) (`gradescope-rubric-import.user.js`): import a question's rubric from a JSON file, and export it back out.
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

On the Create Rubric page every question has its own pair of buttons. The buttons are attached to Gradescope's own markup, so if Gradescope restyles that row they may stop appearing.

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

### Caveats

- **Replace deletes rubric items.** If an item has been applied to submissions, deleting it changes those grades.
- Do not replace the pre-loaded Correct/Incorrect items on auto-graded Online Assignment questions; that breaks their auto-grading.
- Rubric item groups need an Institutional license.
- If rubric permissions lock editing for your role, the import stops at the first rejected request.
- If an import fails partway, it stops and lists what was done. There is no rollback.

## Bubble Sheet Answer Key

A userscript version of [gradescope-bubbler](https://github.com/nyumathclinic/gradescope-bubbler), which does the same thing from Python. Both read the same CSV files.

### Use

Open a bubble sheet assignment's answer-key editor. Two buttons appear in the bottom-right corner:

- **Fill from CSV**: choose a file and check the preview, then click Fill. The whole file, and whether every question and bubble it names is on the page, is checked before anything is clicked. Bubbles not in the key are unchecked.
- **Export CSV**: downloads the bubbles currently checked on the page, in the format below.

The script clicks the editor the way you would and **never saves**. When it finishes, review the answers and click Save. Leaving the page without saving discards the changes.

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

- The buttons appear on any assignment page that has answer-key bubbles. They float in the corner because they aren't attached to Gradescope's toolbar.
- The script relies on the editor's markup (the bubble checkboxes' IDs, the gear menu, the points field). If Gradescope changes it, filling stops with a timeout or "not on this page" message and nothing is saved. The markup is listed at the top of the script's "answer-key editor" section and in gradescope-bubbler's CONTRIBUTING.md.
- **Export** writes `Answers` and, where the page has it, `Points`. It doesn't write `Type`, so re-importing an export leaves scoring types unchanged. Questions with no bubble checked are left out.
