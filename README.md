# gradescope-tampermonkey

A Tampermonkey userscript that imports a Gradescope question's rubric from a JSON file, and exports it back out.

## Status

Gradescope's rubric endpoints are undocumented. The script sends the same requests Gradescope's own pages were seen sending (October 2026). Gradescope can change them without notice; if an import starts failing, set `DEBUG = true` at the top of the script, repeat the action by hand in Gradescope, and use **Copy debug log** to see what the page sends now.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new script and paste in `gradescope-rubric-import.user.js`.
3. Open either the grading view (Grade Submissions, then a question) or the assignment's Create Rubric page. A small panel appears at the bottom left.

## Use

- **Import rubric JSON**: choose a file, check the preview, optionally tick "Replace existing rubric", then Import. The file is fully validated before any request is made, and the page reloads when the import finishes.
- **Export rubric JSON**: downloads the question's rubric in the format below.

In the grading view both act on the question being graded. On the Create Rubric page, pick the question from the list in the panel first.

## JSON format

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

## Caveats

- **Replace deletes rubric items.** If an item has been applied to submissions, deleting it changes those grades.
- Replace works from the rubric as it was when the page loaded. Reload before importing if you have edited the rubric by hand.
- Do not replace the pre-loaded Correct/Incorrect items on auto-graded Online Assignment questions; that breaks their auto-grading.
- Rubric item groups need an Institutional license.
- If rubric permissions lock editing for your role, the import stops at the first rejected request.
- If an import fails partway, it stops and lists what was done. There is no rollback.
