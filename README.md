# edubag-userscripts

Tampermonkey userscripts for the web tools a course runs on. *edubag* is short for education bag; it also stands for Brightspace, Albert and Gradescope. The companion Python package is [python-edubag](https://github.com/nyumathclinic/python-edubag).

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. For each script you want, create a new script in Tampermonkey and paste in the `.user.js` file.

## Scripts

### [Gradescope](gradescope/README.md)

- [**Rubric Import/Export**](gradescope/README.md#rubric-importexport) (`gradescope/rubric-import.user.js`): import a question's rubric, or every rubric in an assignment, from a JSON file, and export it back out.
- [**Bubble Sheet Answer Key**](gradescope/README.md#bubble-sheet-answer-key) (`gradescope/bubble-sheet-key.user.js`): fill in a bubble sheet assignment's answer key from a CSV file, and export it back out.

### [Brightspace](brightspace/README.md)

None yet.
