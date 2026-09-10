/**
 * Fishing reports. The parsing has to survive real-world feeds, and the
 * lake-matching has to be strict: a regional feed that mentions "Fork" must not
 * attach a report about Lake Fork to every lake in Texas.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { htmlToText, mentionsLake, parseFeed, reportsForPrompt } from '../src/services/reports';

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>State fishing reports</title>
  <item>
    <title>Lake Fork — good</title>
    <description><![CDATA[<p>Water stained, 78 degrees. <b>Crappie</b> good on brush 18-22 ft.</p>]]></description>
    <link>https://example.gov/reports/fork</link>
    <pubDate>Mon, 08 Sep 2026 12:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Table Rock — slow</title>
    <description>Fair. Bass slow.</description>
    <link>https://example.gov/reports/tablerock</link>
    <pubDate>Sun, 07 Sep 2026 12:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Granbury report</title>
    <summary>Sand bass schooling early. Water 83.</summary>
    <link href="https://example.gov/atom/granbury"/>
    <published>2026-09-09T10:00:00Z</published>
  </entry>
</feed>`;

describe('parseFeed', () => {
  test('reads RSS items with CDATA and dates', () => {
    const items = parseFeed(RSS);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, 'Lake Fork — good');
    assert.match(items[0].body, /Crappie good on brush/);
    assert.equal(items[0].url, 'https://example.gov/reports/fork');
    assert.equal(items[0].publishedAt?.toISOString().slice(0, 10), '2026-09-08');
  });

  test('reads Atom entries, where the link is an attribute', () => {
    const items = parseFeed(ATOM);
    assert.equal(items.length, 1);
    assert.equal(items[0].url, 'https://example.gov/atom/granbury');
    assert.match(items[0].body, /Sand bass schooling/);
  });

  test('a feed with nothing usable yields nothing, not junk', () => {
    assert.deepEqual(parseFeed('<rss><channel></channel></rss>'), []);
    assert.deepEqual(parseFeed('not xml at all'), []);
  });
});

describe('htmlToText', () => {
  test('strips markup and decodes entities', () => {
    assert.equal(htmlToText('<p>Bass &amp; crappie</p><script>x=1</script>'), 'Bass & crappie');
  });

  test('keeps paragraph breaks as line breaks', () => {
    assert.match(htmlToText('<p>One</p><p>Two</p>'), /One\nTwo/);
  });
});

describe('mentionsLake', () => {
  const item = { body: 'Water stained on Lake Fork, crappie good.', title: 'Lake Fork report' };

  test('matches the lake it names', () => {
    assert.equal(mentionsLake(item, 'Lake Fork'), true);
    assert.equal(mentionsLake(item, 'Fork Reservoir'), true);
  });

  test('does not attach a report to a lake it never mentions', () => {
    assert.equal(mentionsLake(item, 'Lake Granbury'), false);
    assert.equal(mentionsLake(item, 'Table Rock'), false);
  });

  test('a very short lake name is refused rather than matching everything', () => {
    // "Lake X" would otherwise match any body containing an x.
    assert.equal(mentionsLake({ body: 'the bite was excellent' }, 'Lake X'), false);
  });
});

describe('reportsForPrompt', () => {
  test('labels each report with its date and who said it', () => {
    const out = reportsForPrompt([
      { source: 'angler', sourceName: 'Dave', title: null, body: 'Caught 12 on a jig', url: null, publishedAt: new Date('2026-09-08T12:00:00Z') },
      { source: 'agency', sourceName: 'TPWD', title: 'Weekly', body: 'Fair', url: null, publishedAt: null },
    ]);
    assert.match(out, /\[2026-09-08\] \(angler Dave\) Caught 12 on a jig/);
    assert.match(out, /\[undated\] \(TPWD\) Weekly: Fair/);
  });

  test('no reports produces an empty block, not a header with nothing under it', () => {
    assert.equal(reportsForPrompt([]), '');
  });
});
