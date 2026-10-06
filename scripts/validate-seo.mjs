import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = join(process.cwd(), 'dist');
const site = 'https://www.logorytm.com';
const defaultRobots = 'index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1';
const socialProfiles = [
  'https://www.facebook.com/profile.php?id=61574499106160',
  'https://www.instagram.com/logorytm.joannajachowicz',
];
const mapProfileUrl = 'https://www.google.com/maps/place/LOGORYTM+Gabinet+Logopedyczny+Joanna+Jachowicz/@49.6507981,20.7461969,13z/data=!4m6!3m5!1s0x473deff9ea8b45d9:0xaf9a67dc9a6dd3a0!8m2!3d49.6731642!4d20.7784393!16s%2Fg%2F11nbzlh9vv?authuser=0&entry=ttu&g_ep=EgoyMDI2MDQxMi4wIKXMDSoASAFQAw%3D%3D';
const pages = [
  {
    path: '/', file: 'index.html',
    title: 'Logopeda Korzenna – okolice Nowego Sącza i Grybowa | Logorytm',
    description: 'Diagnoza i terapia logopedyczna dzieci w gabinecie Logorytm, Łęka 184 koło Korzennej. Zapraszam rodziny z Nowego Sącza, Grybowa i okolic.',
  },
  {
    path: '/about/', file: 'about/index.html', breadcrumb: 'O mnie',
    title: 'Joanna Jachowicz – logopeda w Łęce | Logorytm',
    description: 'Poznaj Joannę Jachowicz, logopedę prowadzącą Logorytm w Łęce koło Korzennej. Sprawdź wykształcenie, szkolenia i podejście do terapii dzieci.',
  },
  {
    path: '/services/', file: 'services/index.html', breadcrumb: 'Oferta',
    title: 'Diagnoza i terapia logopedyczna – Łęka | Logorytm',
    description: 'Diagnoza i terapia logopedyczna, nauka czytania oraz elektrostymulacja w Łęce koło Korzennej. Oferta dla rodzin z Grybowa i Nowego Sącza.',
  },
  {
    path: '/pricing/', file: 'pricing/index.html', breadcrumb: 'Cennik',
    title: 'Cennik logopedy – diagnoza i terapia | Logorytm',
    description: 'Sprawdź ceny diagnozy, zajęć logopedycznych, elektrostymulacji oraz pakietów w gabinecie Logorytm. Łęka 184, 33-322 Korzenna.',
  },
  {
    path: '/contact/', file: 'contact/index.html', breadcrumb: 'Kontakt',
    title: 'Kontakt i dojazd – logopeda Łęka, Korzenna | Logorytm',
    description: 'Umów wizytę w gabinecie Logorytm Joanny Jachowicz: Łęka 184, 33-322 Korzenna. Telefon 504 759 254. Sprawdź kontakt i lokalizację gabinetu.',
  },
  {
    path: '/privacy/', file: 'privacy/index.html', breadcrumb: 'Polityka prywatności', private: true,
    title: 'Polityka prywatności | Gabinet Logorytm',
    description: 'Informacje o zasadach przetwarzania danych osobowych oraz korzystaniu z Local Storage i usług zewnętrznych w serwisie Logorytm.',
  },
];
const failures = [];

const fail = (message) => failures.push(message);
const count = (html, pattern) => [...html.matchAll(pattern)].length;
const attribute = (html, pattern, label) => {
  const match = html.match(pattern);
  if (!match) fail(`${label}: missing`);
  return match?.[1];
};
const expectEqual = (actual, expected, label) => {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
};
const asSet = (values) => [...new Set(values)].sort();
const distTarget = (pathname) => {
  const cleanPath = decodeURIComponent(pathname).replace(/^\//, '');
  if (!cleanPath) return join(dist, 'index.html');
  return pathname.endsWith('/') ? join(dist, cleanPath, 'index.html') : join(dist, cleanPath);
};

if (!existsSync(dist)) fail('dist directory is missing; run the build first');

const businessTitles = new Set();
const businessDescriptions = new Set();

for (const page of pages) {
  const filePath = join(dist, page.file);
  if (!existsSync(filePath)) {
    fail(`${page.path}: missing ${page.file}`);
    continue;
  }

  const html = readFileSync(filePath, 'utf8');
  const label = page.path;
  expectEqual(count(html, /<title>/g), 1, `${label} title count`);
  expectEqual(count(html, /<meta name="description"/g), 1, `${label} description count`);
  expectEqual(count(html, /<link rel="canonical"/g), 1, `${label} canonical count`);
  expectEqual(count(html, /<h1\b/gi), 1, `${label} H1 count`);
  expectEqual(count(html, /<script type="application\/ld\+json">/g), 1, `${label} JSON-LD count`);
  if (!/<html lang="pl">/.test(html)) fail(`${label}: html language is not pl`);

  const title = attribute(html, /<title>([^<]+)<\/title>/, `${label} title`);
  const description = attribute(html, /<meta name="description" content="([^"]+)"/, `${label} description`);
  expectEqual(title, page.title, `${label} title`);
  expectEqual(description, page.description, `${label} description`);
  if (!page.private) {
    if (businessTitles.has(title)) fail(`${label}: duplicate business title`);
    if (businessDescriptions.has(description)) fail(`${label}: duplicate business description`);
    businessTitles.add(title);
    businessDescriptions.add(description);
    if ((title ?? '').includes('| Logorytm |') || (title ?? '').includes('| Gabinet Logorytm |')) fail(`${label}: duplicated title suffix`);
  }

  const canonical = attribute(html, /<link rel="canonical" href="([^"]+)"/, `${label} canonical`);
  const expectedCanonical = `${site}${page.path}`;
  expectEqual(canonical, expectedCanonical, `${label} canonical`);
  try {
    const parsedCanonical = new URL(canonical);
    if (parsedCanonical.search || parsedCanonical.hash) fail(`${label}: canonical contains query or hash`);
    if (parsedCanonical.origin !== site) fail(`${label}: canonical uses an unexpected origin`);
  } catch {
    fail(`${label}: canonical is not an absolute URL`);
  }

  const metadataPairs = [
    ['og:title', attribute(html, /<meta property="og:title" content="([^"]+)"/, `${label} og:title`), page.title],
    ['og:description', attribute(html, /<meta property="og:description" content="([^"]+)"/, `${label} og:description`), page.description],
    ['twitter:title', attribute(html, /<meta name="twitter:title" content="([^"]+)"/, `${label} twitter:title`), page.title],
    ['twitter:description', attribute(html, /<meta name="twitter:description" content="([^"]+)"/, `${label} twitter:description`), page.description],
    ['og:url', attribute(html, /<meta property="og:url" content="([^"]+)"/, `${label} og:url`), expectedCanonical],
  ];
  for (const [name, actual, expected] of metadataPairs) expectEqual(actual, expected, `${label} ${name}`);
  expectEqual(attribute(html, /<meta property="og:locale" content="([^"]+)"/, `${label} og:locale`), 'pl_PL', `${label} og:locale`);
  expectEqual(attribute(html, /<meta property="og:image" content="([^"]+)"/, `${label} og:image`), `${site}/logorytm-logo.png`, `${label} og:image`);
  expectEqual(attribute(html, /<meta name="twitter:image" content="([^"]+)"/, `${label} twitter:image`), `${site}/logorytm-logo.png`, `${label} twitter:image`);

  const robots = attribute(html, /<meta name="robots" content="([^"]+)"/, `${label} robots`);
  expectEqual(robots, page.private ? 'noindex,follow' : defaultRobots, `${label} robots`);

  const jsonLd = attribute(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/, `${label} JSON-LD`);
  if (jsonLd) {
    if (jsonLd.includes('<')) fail(`${label}: JSON-LD contains a raw < character`);
    if (jsonLd.includes('SpeechTherapy')) fail(`${label}: JSON-LD contains invalid SpeechTherapy`);
    try {
      const data = JSON.parse(jsonLd);
      expectEqual(data['@context'], 'https://schema.org', `${label} JSON-LD context`);
      if (!Array.isArray(data['@graph'])) fail(`${label}: JSON-LD @graph is not an array`);
      const graph = data['@graph'] ?? [];
      const ids = new Map(graph.filter((node) => node['@id']).map((node) => [node['@id'], node]));
      const website = ids.get(`${site}/#website`);
      const business = ids.get(`${site}/#business`);
      const person = ids.get(`${site}/#person`);
      if (!website || !business || !person) fail(`${label}: JSON-LD is missing a stable website, business, or person ID`);

      expectEqual(website?.['@type'], 'WebSite', `${label} website type`);
      expectEqual(website?.publisher?.['@id'], `${site}/#business`, `${label} website publisher`);
      expectEqual(business?.['@type'], 'MedicalClinic', `${label} business type`);
      if (graph.some((node) => node['@type'] === 'Physician')) fail(`${label}: JSON-LD must not use Physician`);
      expectEqual(business?.medicalSpecialty?.['@id'], 'https://schema.org/SpeechPathology', `${label} medicalSpecialty`);
      expectEqual(business?.telephone, '+48 504 759 254', `${label} telephone`);
      expectEqual(business?.email, 'kontaktlogorytm@gmail.com', `${label} email`);
      expectEqual(business?.image, `${site}/logorytm-logo.png`, `${label} image`);
      expectEqual(business?.logo, `${site}/logorytm-logo.png`, `${label} logo`);
      expectEqual(business?.hasMap, mapProfileUrl, `${label} hasMap`);
      expectEqual(JSON.stringify(asSet(business?.sameAs ?? [])), JSON.stringify(asSet(socialProfiles)), `${label} sameAs`);
      expectEqual(business?.geo?.latitude, 49.6731642, `${label} latitude`);
      expectEqual(business?.geo?.longitude, 20.7784393, `${label} longitude`);
      expectEqual(business?.employee?.['@id'], `${site}/#person`, `${label} employee`);
      expectEqual(person?.jobTitle, 'Logopeda', `${label} person job title`);
      expectEqual(person?.worksFor?.['@id'], `${site}/#business`, `${label} person worksFor`);

      const address = business?.address;
      expectEqual(address?.['@type'], 'PostalAddress', `${label} address type`);
      expectEqual(address?.streetAddress, 'Łęka 184', `${label} street address`);
      expectEqual(address?.postalCode, '33-322', `${label} postal code`);
      expectEqual(address?.addressLocality, 'Korzenna', `${label} address locality`);
      expectEqual(address?.addressCountry, 'PL', `${label} address country`);
      expectEqual(count(JSON.stringify(data), /"@type":"PostalAddress"/g), 1, `${label} PostalAddress count`);
      expectEqual(
        JSON.stringify(asSet((business?.areaServed ?? []).map((place) => place.name))),
        JSON.stringify(asSet(['Łęka', 'Korzenna', 'Grybów', 'Nowy Sącz'])),
        `${label} areaServed`,
      );

      for (const property of ['aggregateRating', 'review', 'openingHours', 'openingHoursSpecification']) {
        if (JSON.stringify(data).includes(`"${property}"`)) fail(`${label}: JSON-LD contains forbidden ${property}`);
      }

      const breadcrumbs = graph.filter((node) => node['@type'] === 'BreadcrumbList');
      expectEqual(breadcrumbs.length, page.path === '/' ? 0 : 1, `${label} BreadcrumbList count`);
      if (page.path !== '/') {
        const items = breadcrumbs[0]?.itemListElement ?? [];
        expectEqual(items[0]?.name, 'Strona główna', `${label} breadcrumb home name`);
        expectEqual(items[1]?.name, page.breadcrumb, `${label} breadcrumb page name`);
        expectEqual(items[1]?.item, expectedCanonical, `${label} breadcrumb item`);
      }
    } catch (error) {
      fail(`${label}: JSON-LD is invalid (${error.message})`);
    }
  }

  for (const favicon of ['/favicon.ico', '/favicon-32x32.png', '/favicon-96x96.png', '/apple-touch-icon.png']) {
    if (!html.includes(`href="${favicon}"`)) fail(`${label}: missing favicon reference ${favicon}`);
  }

  const localReferences = [
    ...html.matchAll(/(?:src|href)="(\/[^"?#]*)(?:[?#][^"]*)?"/g),
    ...html.matchAll(/srcset="([^"]+)"/g),
  ].flatMap((match) => {
    if (match[0].startsWith('srcset=')) {
      return match[1].split(',').map((candidate) => candidate.trim().split(/\s+/)[0]).filter((url) => url.startsWith('/'));
    }
    return [match[1]];
  });
  for (const reference of new Set(localReferences)) {
    if (!existsSync(distTarget(reference))) fail(`${label}: local reference does not exist in dist: ${reference}`);
  }

  if (/href="\/(?:about|services|pricing|contact|privacy)"/.test(html)) fail(`${label}: internal canonical route is linked without a trailing slash`);
}

for (const asset of ['favicon.ico', 'favicon-32x32.png', 'favicon-96x96.png', 'apple-touch-icon.png', 'logorytm-logo.png']) {
  if (!existsSync(join(dist, asset))) fail(`missing dist/${asset}`);
}

const home = readFileSync(join(dist, 'index.html'), 'utf8');
const services = readFileSync(join(dist, 'services/index.html'), 'utf8');
for (const id of ['terapia', 'nauka-czytania', 'elektrostymulacja']) {
  if (!home.includes(`href="/services/#${id}"`)) fail(`homepage is missing the service link /services/#${id}`);
  if (!services.includes(`id="${id}"`)) fail(`services page is missing id="${id}"`);
}
if (!services.includes('id="diagnoza"')) fail('services page is missing id="diagnoza"');
for (const heading of ['Diagnoza logopedyczna', 'Terapia logopedyczna', 'Nauka czytania', 'Elektrostymulacja']) {
  if (!new RegExp(`<h2[^>]*>${heading}<\\/h2>`).test(services)) fail(`service heading is not H2: ${heading}`);
  if (new RegExp(`<h3[^>]*>${heading}<\\/h3>`).test(services)) fail(`service heading remains H3: ${heading}`);
}
if (count(home, /aria-label="Więcej szczegółów o [^"]+"/g) !== 3) fail('homepage service links do not have three precise aria-label values');

const contact = readFileSync(join(dist, 'contact/index.html'), 'utf8');
const mapIframe = contact.match(/<iframe[\s\S]*?<\/iframe>/)?.[0] ?? '';
if (!mapIframe.includes('data-map-src="https://maps.google.com/')) fail('contact map iframe is missing data-map-src');
if (/\ssrc="https:\/\/maps\.google\.com/.test(mapIframe)) fail('contact map iframe loads Google Maps before consent');
if (!contact.includes('data-nosnippet')) fail('privacy modal copy is missing data-nosnippet');

const robots = readFileSync(join(dist, 'robots.txt'), 'utf8');
if (!robots.includes(`Sitemap: ${site}/sitemap-index.xml`)) fail('robots.txt has an incorrect sitemap URL');
if (/Disallow:\s*\/\s*$/m.test(robots)) fail('robots.txt blocks all business pages');
const sitemapIndex = readFileSync(join(dist, 'sitemap-index.xml'), 'utf8');
expectEqual(sitemapIndex.match(/<loc>([^<]+)<\/loc>/)?.[1], `${site}/sitemap-0.xml`, 'sitemap index entry');
const sitemap = readFileSync(join(dist, 'sitemap-0.xml'), 'utf8');
const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
const expectedLocations = pages.filter((page) => !page.private).map((page) => `${site}${page.path}`);
expectEqual(JSON.stringify(asSet(locations)), JSON.stringify(asSet(expectedLocations)), 'sitemap canonical URL set');
expectEqual(locations.length, expectedLocations.length, 'sitemap URL count');
if (locations.some((url) => new URL(url).search || new URL(url).hash)) fail('sitemap contains a URL with query or hash');
if (!sitemap.startsWith('<?xml')) fail('sitemap is not XML');

const astroConfig = readFileSync(join(process.cwd(), 'astro.config.mjs'), 'utf8');
if (!astroConfig.includes("site: 'https://www.logorytm.com'")) fail('Astro site URL is not https://www.logorytm.com');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`SEO validation passed for ${pages.length} pages; ${businessTitles.size} business title/description pairs are unique and sitemap contains ${locations.length} canonical URLs.`);
