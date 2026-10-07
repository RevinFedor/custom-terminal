import assert from 'node:assert/strict';
import path from 'node:path';

export async function runHistoryMcpColorCases(page, app, { artifact, result }) {
  await page.waitForSelector('[data-timeline-entry-uuid="mcp-plain"]');
  await page.waitForSelector('[data-uuid="mcp-reply"] .cb-user-bubble');
  for (const width of [350, 500, 1100]) {
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 1150), width);
    await page.waitForFunction(width => innerWidth === width, width);
    await page.evaluate(width => window.fixture.resize(width), width);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('history-panel:scroll-to-bottom', {
      detail: { tabId: window.fixture.tabId },
    })));
    await page.waitForFunction(() => {
      const scroller = document.querySelector('[data-virtuoso-scroller]');
      const first = document.querySelector('[data-uuid="mcp-plain"] .cb-user-bubble');
      const last = document.querySelector('[data-uuid="mcp-reply"] .cb-user-bubble');
      if (!scroller || !first || !last) return false;
      const viewport = scroller.getBoundingClientRect();
      return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 2
        && first.getBoundingClientRect().top >= viewport.top && last.getBoundingClientRect().bottom <= viewport.bottom;
    });
    await page.waitForSelector('[data-history-viewport-loader]', { state: 'hidden' });
    await app.evaluate(({ BrowserWindow }) => new Promise((resolve, reject) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      let timer;
      const finish = error => { clearTimeout(timer); contents.removeListener('paint', painted); error ? reject(error) : resolve(true); };
      const painted = () => finish();
      timer = setTimeout(() => finish(new Error('MCP color native paint timed out')), 3000);
      contents.once('paint', painted);
      try { contents.invalidate(); } catch (error) { finish(error); }
    }));
    const cases = await page.evaluate(() => ['mcp-plain', 'mcp-question', 'mcp-reply', 'ordinary-quote'].map(uuid => {
      const bubble = document.querySelector(`[data-uuid="${uuid}"] .cb-user-bubble`);
      const rail = document.querySelector(`[data-timeline-entry-uuid="${uuid}"]`);
      const diamond = [...rail.querySelectorAll('div')].find(e => e.style.transform === 'rotate(45deg)');
      const source = document.querySelector(`[data-uuid="${uuid}"] [data-history-tab-message-source]`);
      const b = bubble.getBoundingClientRect(), r = rail.getBoundingClientRect();
      return { uuid, className: bubble.className, background: getComputedStyle(bubble).backgroundColor,
        bgVariable: getComputedStyle(bubble).getPropertyValue('--cb-user-bubble-bg').trim(),
        marker: diamond ? { color: getComputedStyle(diamond).backgroundColor, width: diamond.offsetWidth, height: diamond.offsetHeight } : null,
        sourceDirection: source?.querySelector('[data-history-source-direction]')?.getAttribute('data-history-source-direction') || null,
        sourceText: source?.textContent || '',
        bubble: { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height },
        rail: { left: r.left, right: r.right }, viewport: innerWidth };
    }));
    for (const row of cases) {
      assert.ok(row.bubble.width > 0 && row.bubble.height > 0);
      assert.ok(row.bubble.left >= 0 && row.bubble.right <= width, JSON.stringify(row));
      assert.ok(row.bubble.top >= 70 && row.bubble.bottom <= 1150, 'colored row must actually be visible in the screenshot');
      assert.ok(row.rail.left >= 0 && row.rail.right <= width);
      if (row.uuid === 'ordinary-quote') {
        assert.ok(!row.className.includes('--orchestration'));
        assert.equal(row.marker, null);
      } else {
        assert.match(row.className, /hp-history-user-bubble--orchestration/);
        assert.equal(row.bgVariable, 'rgba(124, 58, 237, 0.08)');
        assert.ok(row.marker, 'MCP iteration remains a purple diamond');
        assert.equal(row.marker.width, row.marker.height, 'no diagonal-line geometry');
        const rgb = row.marker.color.match(/\d+/g).map(Number);
        assert.ok(rgb[2] > rgb[1] && rgb[0] > rgb[1], row.marker.color);
        if (row.uuid === 'mcp-question' || row.uuid === 'mcp-reply') {
          assert.equal(row.sourceDirection, row.uuid === 'mcp-question' ? 'incoming-request' : 'response');
          assert.equal(row.sourceText, 'state terminal - fork / rewind with a long source name', 'one source name, no repeated Question/Reply caption');
        }
      }
    }
    await page.screenshot({ path: path.join(artifact, `mcp-colors-${width}.png`) });
    (result.mcpColors ||= []).push({ width, cases });
  }
  result.checks.push('plain MCP, question and reply have purple History bubbles and Timeline diamonds; quoted text stays ordinary at three widths');
  await page.evaluate(() => window.fixture.destroy());
  result.rollback = true; result.verdict = 'PASS';
}
