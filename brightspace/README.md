# Brightspace userscripts

- [**Enter Grades Helpers**](#enter-grades-helpers) (`enter-grades.user.js`): on a grade item's Enter Grades page, set blank grades to zero with a comment, and give kudos to students at full marks.

To install, see the [top-level README](../README.md#install).

## Enter Grades Helpers

### Use

Open a numeric grade item's Enter Grades page (the URL contains `grade_item_edit.d2l`). The grid's action bar (Set Grades, Clear Grades, ...) gains two buttons; on a narrow window they may be under **More Actions**.

- **Set Blanks to Zero**: selects every student whose grade is blank, except exempt students, and lists them. Edit the comment (default "Not submitted"; leave it empty for none), then click Save. Each one gets a grade of 0 and the comment, added before any feedback already there.
- **Give Kudos**: selects every student whose grade is at or above the maximum and lists them. Save adds a congratulatory remark, picked at random for each student, before any feedback already there. The grade is unchanged. Students who already have one of the remarks are skipped, so running it again is harmless. The remarks are the `KUDOS` list at the top of the script.

Before saving, each student's grade is read back from Brightspace. A student is skipped, with the reason shown, if the page was out of date: a "blank" student who already has a saved grade, or a full-marks student whose saved grade is lower.

### Caveats

- **Saving is immediate.** The script saves through Brightspace's grades API (the same one its own tools use, with your login), one student at a time, then reloads the page. Unsaved edits on the page are lost; save them first.
- Only the students shown on the page are included. If the grid is paged, set Results Per Page high enough to show everyone.
- Private feedback is kept as it is.
- If a request fails, the script stops and lists who was done. There is no undo.
- If your role isn't allowed to use the API, the first save fails with a 403 and nothing is changed.
