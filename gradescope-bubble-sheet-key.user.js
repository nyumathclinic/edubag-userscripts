// ==UserScript==
// @name         Gradescope Bubble Sheet Answer Key
// @namespace    https://github.com/nyumathclinic/gradescope-tampermonkey
// @version      0.1.0
// @description  Fill in a bubble sheet assignment's answer key from a CSV file, and export it back out. After gradescope-bubbler by Julius Damarackas.
// @author       Matthew Leingang
// @match        https://www.gradescope.com/courses/*/assignments/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Same CSV format and page automation as gradescope-bubbler
  // (https://github.com/nyumathclinic/gradescope-bubbler). The script clicks
  // the answer-key editor the way a person would and never saves; the user
  // reviews the page and clicks Save.

  const LETTERS = 'ABCDE';
  const SEPARATORS = ' ,;';
  const TIMEOUT_MS = 8000;

  // ---------------------------------------------------------------------------
  // CSV
  // ---------------------------------------------------------------------------

  // RFC 4180 records, each with the (1-based) line it ends on. Fully blank
  // lines are dropped, as Python's csv module does.
  function parseCsv(text) {
    const records = [];
    let record = [];
    let field = '';
    let quoted = false;
    let line = 1;
    const endRecord = () => {
      record.push(field);
      if (record.length > 1 || record[0] !== '') records.push({ fields: record, line });
      record = [];
      field = '';
    };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (c === '"') {
          quoted = false;
        } else {
          if (c === '\n') line++;
          field += c;
        }
      } else if (c === '"') {
        quoted = true;
      } else if (c === ',') {
        record.push(field);
        field = '';
      } else if (c === '\r' || c === '\n') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        endRecord();
        line++;
      } else {
        field += c;
      }
    }
    if (field !== '' || record.length) endRecord();
    return records;
  }

  const csvField = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const toCsv = (rows) => rows.map((r) => r.map(csvField).join(',')).join('\n') + '\n';

  const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

  // Port of gradescope_bubbler.answer_key.parse. Returns { rows, errors },
  // rows being [{ question, letters, points, type }].
  function parseKey(text) {
    const [header, ...records] = parseCsv(text.replace(/^﻿/, ''));
    const columns = header?.fields ?? [];
    const errors = [];
    if (!columns.includes('Question')) errors.push("missing 'Question' column");
    if (!columns.includes('Answers') && !columns.includes('Answer')) errors.push("missing 'Answers' column");
    if (errors.length) return { rows: [], errors };

    const rows = [];
    const seen = new Set();
    for (const { fields, line } of records) {
      const record = Object.fromEntries(columns.map((name, i) => [name, fields[i] ?? '']));
      const q = (record.Question ?? '').trim();
      const ans = (record.Answers || record.Answer || '').trim();
      const points = (record.Points ?? '').trim();
      const type = (record.Type ?? '').trim();
      if (!q) continue;
      if (seen.has(q)) {
        errors.push(`line ${line}: question ${q} appears more than once`);
        continue;
      }
      seen.add(q);

      const letters = [];
      let invalid = false;
      for (const c of ans.toUpperCase()) {
        if (SEPARATORS.includes(c)) continue;
        if (!LETTERS.includes(c)) {
          invalid = true;
          break;
        }
        if (!letters.includes(c)) letters.push(c);
      }
      if (invalid) {
        errors.push(`line ${line}: question ${q} has invalid answer '${ans}' (use letters A-E)`);
        continue;
      }
      if (!letters.length) {
        errors.push(`line ${line}: question ${q} has no answer`);
        continue;
      }
      if (points && !NUMBER.test(points)) {
        errors.push(`line ${line}: question ${q} has non-numeric points '${points}'`);
        continue;
      }
      rows.push({ question: q, letters, points, type });
    }
    return { rows, errors };
  }

  function summarize(rows) {
    const withPoints = rows.filter((r) => r.points);
    const lines = [`${rows.length} question(s)`];
    if (withPoints.length) {
      const total = withPoints.reduce((sum, r) => sum + Number(r.points), 0);
      const rest = withPoints.length < rows.length ? `; ${rows.length - withPoints.length} other question(s) keep their current points` : '';
      lines.push(`Points total ${total}${rest}`);
    } else {
      lines.push('Points: unchanged');
    }
    const types = [...new Set(rows.map((r) => r.type).filter(Boolean))];
    lines.push(types.length ? `Scoring type(s): ${types.join(', ')}` : 'Scoring types: unchanged');
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // The answer-key editor
  // ---------------------------------------------------------------------------

  // Gradescope's markup, as gradescope-bubbler's filler.py relies on it:
  //   bubble checkbox   #question_{q}_{L}, clicked through label[for=...]
  //   settings button   .fa-gear in the fieldset holding #question_{q}_A
  //   points field      #num-points-q{q}, inside a .jBox-content popup
  //   scoring type      a button in that popup whose text is the type
  const bubble = (q, letter) => document.getElementById(`question_${q}_${letter}`);
  const bubbleLabel = (q, letter) => document.querySelector(`label[for="${CSS.escape(`question_${q}_${letter}`)}"]`);
  const pointsField = (q) => document.getElementById(`num-points-q${q}`);
  const gearFor = (q) => bubble(q, 'A')?.closest('fieldset')?.querySelector('.fa-gear');

  const BUBBLE_ID = /^question_(.+)_([A-E])$/;

  // Question numbers on the page, in page order.
  function pageQuestions() {
    const questions = [];
    for (const input of document.querySelectorAll('input[id^="question_"]')) {
      const m = input.id.match(BUBBLE_ID);
      if (m && !questions.includes(m[1])) questions.push(m[1]);
    }
    return questions;
  }

  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(check, what) {
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const result = check();
      if (result) return result;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await pause(50);
    }
  }

  // Problems that would stop the fill partway, found before anything is clicked.
  function checkAgainstPage(rows) {
    const problems = [];
    for (const { question: q, letters, points, type } of rows) {
      if (!bubble(q, 'A')) {
        problems.push(`Q${q} is not on this page`);
        continue;
      }
      for (const letter of letters) {
        if (!bubble(q, letter)) problems.push(`Q${q} has no bubble ${letter} on this page`);
      }
      if ((points || type) && !gearFor(q)) problems.push(`Q${q} has no settings button on this page`);
    }
    return problems;
  }

  async function setBubbles(q, letters) {
    for (const letter of LETTERS) {
      const box = bubble(q, letter);
      if (!box) continue;
      const want = letters.includes(letter);
      if (box.checked === want) continue;
      (bubbleLabel(q, letter) ?? box).click();
      await pause(0);
      if (box.checked !== want) throw new Error(`Q${q}: could not ${want ? 'check' : 'uncheck'} bubble ${letter}`);
    }
  }

  // Set the value so that both plain listeners and React notice the change.
  function setValue(input, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function setSettings(q, points, type) {
    const gear = gearFor(q);
    gear.click();
    const field = await waitFor(() => (visible(pointsField(q)) ? pointsField(q) : null), `Q${q}'s settings`);
    if (points) setValue(field, points);
    if (type) {
      const popup = field.closest('.jBox-content') ?? field.parentElement;
      const button = [...popup.querySelectorAll('button')].find((b) => b.textContent.trim() === type);
      if (!button) throw new Error(`Q${q}: no scoring type "${type}" in the settings`);
      button.click();
    }
    gear.click();
    await waitFor(() => !visible(pointsField(q)), `Q${q}'s settings to close`);
  }

  async function fill(rows, log) {
    for (const { question: q, letters, points, type } of rows) {
      await setBubbles(q, letters);
      if (points || type) await setSettings(q, points, type);
      log(`✓ Q${q}: ${letters.join('')}`);
    }
  }

  // Questions with no bubble checked are left out, since a key row needs an
  // answer. The scoring type isn't exported: how the page marks the selected
  // one is unknown.
  function exportKey() {
    const rows = [['Question', 'Answers', 'Points', 'Type']];
    for (const q of pageQuestions()) {
      const answers = [...LETTERS].filter((letter) => bubble(q, letter)?.checked).join('');
      if (answers) rows.push([q, answers, pointsField(q)?.value ?? '', '']);
    }
    download('answer-key.csv', toCsv(rows));
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  function download(filename, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function openFillDialog() {
    // In a shadow root so Gradescope's stylesheet does not reach the dialog.
    const host = document.createElement('div');
    host.attachShadow({ mode: 'open' }).innerHTML = `
      <dialog style="max-width:520px;width:90vw;padding:16px;border:1px solid #999;border-radius:6px;font:14px/1.4 sans-serif">
        <h3 style="margin:0 0 12px">Fill in the answer key from a CSV</h3>
        <input type="file" accept=".csv,text/csv">
        <pre data-role="status" style="white-space:pre-wrap;max-height:260px;overflow:auto;margin:12px 0;font-size:12px"></pre>
        <div style="text-align:right">
          <button type="button" data-role="cancel">Close</button>
          <button type="button" data-role="fill" disabled>Fill</button>
        </div>
      </dialog>`;
    const dialog = host.shadowRoot.querySelector('dialog');
    const fileInput = dialog.querySelector('input[type=file]');
    const status = dialog.querySelector('[data-role=status]');
    const fillButton = dialog.querySelector('[data-role=fill]');
    const say = (line) => {
      status.textContent += `${line}\n`;
      status.scrollTop = status.scrollHeight;
    };
    let rows = null;

    fileInput.addEventListener('change', async () => {
      rows = null;
      fillButton.disabled = true;
      status.textContent = '';
      const file = fileInput.files[0];
      if (!file) return;
      const result = parseKey(await file.text());
      const problems = result.errors.length ? result.errors : checkAgainstPage(result.rows);
      if (problems.length) {
        say(`${problems.length} problem(s), nothing will be filled in:`);
        problems.forEach((p) => say(`  ${p}`));
        return;
      }
      rows = result.rows;
      say(summarize(rows));
      say('\nBubbles not in the key will be unchecked.');
      fillButton.disabled = false;
    });

    fillButton.addEventListener('click', async () => {
      fillButton.disabled = true;
      fileInput.disabled = true;
      // The page may have changed since the file was chosen.
      const problems = checkAgainstPage(rows);
      if (problems.length) {
        say(`\n${problems.length} problem(s), nothing was filled in:`);
        problems.forEach((p) => say(`  ${p}`));
        fileInput.disabled = false;
        return;
      }
      say('');
      try {
        await fill(rows, say);
      } catch (e) {
        say(`\nStopped: ${e.message}\nQuestions marked ✓ above were filled in; the rest were not. Nothing has been saved.`);
        return;
      }
      say('\nDone. Review the answers, then click Save.');
    });

    dialog.querySelector('[data-role=cancel]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => host.remove());
    document.body.append(host);
    dialog.showModal();
  }

  // A button styled like Gradescope's secondary buttons.
  function button(label, icon, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tiiBtn tiiBtn-secondary';
    b.innerHTML = `<span><i class="fa ${icon}" role="img" aria-hidden="true"></i><span></span></span>`;
    b.querySelector('span span').textContent = ` ${label}`;
    b.addEventListener('click', onClick);
    return b;
  }

  // The editor's toolbar markup is unknown, so the buttons float bottom-right.
  function addButtons() {
    if (document.querySelector('[data-bubble-sheet-key]') || !pageQuestions().length) return;
    const bar = document.createElement('div');
    bar.dataset.bubbleSheetKey = '';
    bar.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:10000;display:flex;gap:8px';
    bar.append(
      button('Fill from CSV', 'fa-upload', openFillDialog),
      button('Export CSV', 'fa-download', exportKey),
    );
    document.body.append(bar);
  }

  addButtons();
  // The editor may render after the page loads.
  new MutationObserver(addButtons).observe(document.body, { childList: true, subtree: true });
})();
