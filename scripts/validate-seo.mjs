import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = join(process.cwd(), 'dist');
const pages = [
  ['/', 'index.html', 'Logopeda Korzenna i okolice | Gabinet Logorytm'],
  ['/about/', 'about/index.html', 'Joanna Jachowicz – logopeda | Gabinet Logorytm'],
  ['/services/', 'services/index.html', 'Terapia i diagnoza logopedyczna | Logorytm'],
  ['/pricing/', 'pricing/index.html', 'Cennik usług logopedycznych | Gabinet Logorytm'],
  ['/contact/', 'contact/index.html', 'Kontakt – logopeda Łęka, Korzenna | Logorytm'],
  ['/privacy/', 'privacy/index.html', 'Polityka prywatności | Gabinet Logorytm'],
];
const site = 'https://www.logorytm.com';
const defaultRobots = 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1';
const failures = [];

const count = (html, pattern) => [...html.matchAll(pattern)].length;
const attribute = (html, pattern, label) => {
  const match = html.match(pattern);
  if (!match) failures.push(`${label}: missing`);
  return match?.[1];
};

for (const [path, file, expectedTitle] of pages) {
  const html = readFileSync(join(dist, file), 'utf8');
  const label = path;
  if (count(html, /<title>/g) !== 1) failures.push(`${label}: expected one title`);
  if (count(html, /<meta name="description"/g) !== 1) failures.push(`${label}: expected one meta description`);
  if (count(html, /<link rel="canonical"/g) !== 1) failures.push(`${label}: expected one canonical`);
  if (count(html, /<h1\b/gi) !== 1) failures.push(`${label}: expected one H1`);

  const title = attribute(html, /<title>([^<]+)<\/title>/, `${label} title`);
  if (title && title !== expectedTitle) failures.push(`${label}: unexpected title`);
  const description = attribute(html, /<meta name="description" content="([^"]+)"/, `${label} description`);
  if (description && (description.length < 120 || description.length > 160)) {
    failures.push(`${label}: description length is ${description.length}, expected 120–160`);
  }
  const canonical = attribute(html, /<link rel="canonical" href="([^"]+)"/, `${label} canonical`);
  const expectedCanonical = `${site}${path}`;
  if (canonical !== expectedCanonical) failures.push(`${label}: canonical is not ${expectedCanonical}`);
  const ogUrl = attribute(html, /<meta property="og:url" content="([^"]+)"/, `${label} og:url`);
  if (ogUrl !== canonical || !/^https:\/\//.test(ogUrl ?? '')) failures.push(`${label}: og:url differs from canonical or is not absolute`);
  const ogImage = attribute(html, /<meta property="og:image" content="([^"]+)"/, `${label} og:image`);
  const twitterImage = attribute(html, /<meta name="twitter:image" content="([^"]+)"/, `${label} twitter:image`);
  if (ogImage !== `${site}/logorytm-logo.png` || twitterImage !== ogImage) failures.push(`${label}: social image is not the expected absolute URL`);
  for (const property of ['og:locale', 'og:site_name', 'og:type', 'og:title', 'og:description']) {
    if (!html.includes(`property="${property}"`)) failures.push(`${label}: missing ${property}`);
  }
  for (const name of ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) {
    if (!html.includes(`name="${name}"`)) failures.push(`${label}: missing ${name}`);
  }
  const robots = attribute(html, /<meta name="robots" content="([^"]+)"/, `${label} robots`);
  const expectedRobots = path === '/privacy/' ? 'noindex,follow' : defaultRobots;
  if (robots !== expectedRobots) failures.push(`${label}: robots is not ${expectedRobots}`);

  const jsonLd = attribute(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/, `${label} JSON-LD`);
  if (jsonLd) {
    try {
      const data = JSON.parse(jsonLd);
      const ids = new Set(data['@graph']?.map((node) => node['@id']));
      for (const id of [`${site}/#website`, `${site}/#business`, `${site}/#person`]) {
        if (!ids.has(id)) failures.push(`${label}: JSON-LD missing ${id}`);
      }
    } catch (error) {
      failures.push(`${label}: JSON-LD is invalid (${error.message})`);
    }
  }
}

for (const asset of ['favicon.ico', 'favicon-32x32.png', 'favicon-96x96.png', 'apple-touch-icon.png', 'logorytm-logo.png']) {
  if (!existsSync(join(dist, asset))) failures.push(`missing dist/${asset}`);
}

const robots = readFileSync(join(dist, 'robots.txt'), 'utf8');
if (!robots.includes('Sitemap: https://www.logorytm.com/sitemap-index.xml')) failures.push('robots.txt has an incorrect sitemap URL');
const sitemapIndex = readFileSync(join(dist, 'sitemap-index.xml'), 'utf8');
const sitemapMatch = sitemapIndex.match(/<loc>([^<]+)<\/loc>/);
if (!sitemapMatch || sitemapMatch[1] !== `${site}/sitemap-0.xml`) failures.push('sitemap-index.xml has an incorrect sitemap entry');
const sitemap = readFileSync(join(dist, 'sitemap-0.xml'), 'utf8');
const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
const expectedLocations = pages.slice(0, 5).map(([path]) => `${site}${path}`);
if (new Set(locations).size !== locations.length) failures.push('sitemap has duplicate URLs');
if (locations.length !== expectedLocations.length || expectedLocations.some((url) => !locations.includes(url))) failures.push('sitemap does not contain exactly the five canonical indexable URLs');
if (locations.some((url) => !url.startsWith(`${site}/`) || url.includes('/privacy/'))) failures.push('sitemap contains a non-canonical or privacy URL');
if (!sitemap.startsWith('<?xml')) failures.push('sitemap is not XML');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`SEO validation passed for ${pages.length} pages; descriptions are 120–160 characters and sitemap contains ${locations.length} canonical URLs.`);
