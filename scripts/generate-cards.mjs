#!/usr/bin/env node
// Builds the profile README cards as static SVGs into assets/.
// No dependencies (Node 18+). Runs daily from .github/workflows/cards.yml.
// Local run:  GITHUB_TOKEN=$(gh auth token) node scripts/generate-cards.mjs

import { mkdir, writeFile } from 'node:fs/promises';

const USER = process.argv[2] || process.env.GH_USER || 'talhaozbay';
const TOKEN = process.env.GITHUB_TOKEN;
const OUT = new URL('../assets/', import.meta.url);

const C = {
  bg: '#0d0d0d', bar: '#161616', border: '#262626',
  title: '#7fff00', text: '#e6e6e6', muted: '#7d8590',
  accent: '#ff0033', blue: '#00aeff', orange: '#ff6b35',
};
const MONO = "'JetBrains Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace";

// ---------------------------------------------------------------- data

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': `${USER}-readme-cards`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    throw new Error(`GraphQL ${res.status}: ${JSON.stringify(body.errors || body)}`);
  }
  return body.data;
}

async function fetchProfile() {
  const q = `query($login: String!, $after: String) {
    user(login: $login) {
      name login createdAt
      followers { totalCount }
      pullRequests { totalCount }
      issues { totalCount }
      repositoriesContributedTo(contributionTypes: [COMMIT, PULL_REQUEST, ISSUE, REPOSITORY]) { totalCount }
      repositories(first: 100, after: $after, privacy: PUBLIC, ownerAffiliations: OWNER, isFork: false) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          stargazerCount
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { name color } }
          }
        }
      }
    }
  }`;
  let after = null, user, repos = [];
  do {
    ({ user } = await gql(q, { login: USER, after }));
    if (!user) throw new Error(`User not found: ${USER}`);
    repos.push(...user.repositories.nodes);
    after = user.repositories.pageInfo.hasNextPage ? user.repositories.pageInfo.endCursor : null;
  } while (after);
  return { user, repos };
}

// contributionsCollection spans at most one year, so ask for every year in one aliased query.
async function fetchYears(createdAt) {
  const now = new Date();
  const first = new Date(createdAt).getUTCFullYear();
  const parts = [];
  for (let y = first; y <= now.getUTCFullYear(); y++) {
    const to = y === now.getUTCFullYear() ? now.toISOString() : `${y}-12-31T23:59:59Z`;
    parts.push(`y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${to}") {
      totalCommitContributions
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
    }`);
  }
  const { user } = await gql(`query($login: String!) { user(login: $login) { ${parts.join('\n')} } }`, { login: USER });
  const today = now.toISOString().slice(0, 10);
  const years = Object.entries(user)
    .map(([k, v]) => ({ year: +k.slice(1), commits: v.totalCommitContributions, total: v.contributionCalendar.totalContributions, cal: v.contributionCalendar }))
    .sort((a, b) => a.year - b.year);
  const days = years
    .flatMap((y) => y.cal.weeks.flatMap((w) => w.contributionDays))
    .filter((d) => d.date <= today)
    .map((d) => ({ date: d.date, count: d.contributionCount }));
  // Calendars of neighbouring years can overlap by a few days at the week edges.
  const unique = [...new Map(days.map((d) => [d.date, d])).values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  return { years, days: unique };
}

function streaks(days) {
  let longest = 0, longestStart = null, longestEnd = null, run = 0, runStart = null;
  for (const d of days) {
    if (d.count > 0) {
      if (!run) runStart = d.date;
      run++;
      if (run > longest) [longest, longestStart, longestEnd] = [run, runStart, d.date];
    } else run = 0;
  }
  // Today not having a contribution yet should not break the current streak.
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--;
  let current = 0, currentStart = null;
  const currentEnd = i >= 0 && days[i].count > 0 ? days[i].date : null;
  while (i >= 0 && days[i].count > 0) { current++; currentStart = days[i].date; i--; }
  return { current, currentStart, currentEnd, longest, longestStart, longestEnd };
}

function languages(repos) {
  const map = new Map();
  for (const r of repos) {
    for (const e of r.languages.edges) {
      const cur = map.get(e.node.name) || { name: e.node.name, color: e.node.color || C.muted, size: 0 };
      cur.size += e.size;
      map.set(e.node.name, cur);
    }
  }
  const list = [...map.values()].sort((a, b) => b.size - a.size);
  const total = list.reduce((s, l) => s + l.size, 0) || 1;
  return list.slice(0, 6).map((l) => ({ ...l, pct: (l.size / total) * 100 }));
}

// ---------------------------------------------------------------- svg helpers

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${+(n / 1e3).toFixed(1)}k` : n.toLocaleString('en-US'));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (iso) => (iso ? `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}, ${iso.slice(0, 4)}` : '-');

// Terminal-window frame shared by every card.
function frame(w, h, title, body, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">
<title>${esc(label)}</title>
<style>text { font-family: ${MONO}; }</style>
<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="8" fill="${C.bg}" stroke="${C.border}"/>
<path d="M.5 30V8.5a8 8 0 0 1 8-8h${w - 17}a8 8 0 0 1 8 8V30z" fill="${C.bar}"/>
<line x1=".5" y1="30" x2="${w - .5}" y2="30" stroke="${C.border}"/>
<circle cx="16" cy="15.5" r="5" fill="#ff5f56"/><circle cx="32" cy="15.5" r="5" fill="#ffbd2e"/><circle cx="48" cy="15.5" r="5" fill="#27c93f"/>
<text x="${w / 2}" y="19.5" text-anchor="middle" font-size="11" fill="${C.muted}">${esc(title)}</text>
${body}
</svg>
`;
}


// ---------------------------------------------------------------- cards

function statsCard({ user, repos, years }) {
  const stars = repos.reduce((s, r) => s + r.stargazerCount, 0);
  const thisYear = years[years.length - 1];
  const rows = [
    ['stars', fmt(stars)],
    [`commits (${thisYear.year})`, fmt(thisYear.commits)],
    ['commits (all)', fmt(years.reduce((s, y) => s + y.commits, 0))],
    ['pull requests', fmt(user.pullRequests.totalCount)],
    ['issues', fmt(user.issues.totalCount)],
    ['contributed to', fmt(user.repositoriesContributedTo.totalCount)],
    ['public repos', fmt(user.repositories.totalCount)],
  ];
  const w = 450, h = 220;
  const body = [
    `<text x="20" y="54" font-size="13"><tspan fill="${C.accent}">&gt;</tspan> <tspan fill="${C.title}" font-weight="700">whoami</tspan> <tspan fill="${C.text}">${esc(user.name || user.login)}</tspan></text>`,
    ...rows.map(([k, v], i) => {
      const y = 82 + i * 19;
      return `<g>
  <text x="20" y="${y}" font-size="12" fill="${C.muted}"><tspan fill="${C.blue}">$</tspan> ${esc(k)}</text>
  <line x1="${44 + k.length * 7.3}" y1="${y - 4}" x2="${w - 30 - v.length * 7.8}" y2="${y - 4}" stroke="${C.border}" stroke-dasharray="1 4"/>
  <text x="${w - 20}" y="${y}" font-size="13" font-weight="700" text-anchor="end" fill="${C.text}">${esc(v)}</text>
</g>`;
    }),
  ].join('\n');
  return frame(w, h, `~/${user.login} — stats`, body, `${user.name || user.login}'s GitHub stats`);
}

function langsCard({ user, langs }) {
  const w = 450, h = 220, barW = w - 40;
  let x = 20;
  const bar = langs.map((l) => {
    const seg = Math.max((l.pct / 100) * barW, 2);
    const r = `<rect x="${x.toFixed(2)}" y="50" width="${seg.toFixed(2)}" height="10" fill="${l.color}"/>`;
    x += seg;
    return r;
  }).join('');
  const legend = langs.map((l, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const lx = 20 + col * 215, ly = 100 + row * 34;
    return `<g>
  <circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${l.color}"/>
  <text x="${lx + 18}" y="${ly}" font-size="12" fill="${C.text}">${esc(l.name)}</text>
  <text x="${lx + 195}" y="${ly}" font-size="12" text-anchor="end" fill="${C.muted}">${l.pct.toFixed(1)}%</text>
</g>`;
  }).join('\n');
  const body = `<clipPath id="bar"><rect x="20" y="50" width="${barW}" height="10" rx="5"/></clipPath>
<rect x="20" y="50" width="${barW}" height="10" rx="5" fill="${C.border}"/>
<g clip-path="url(#bar)">${bar}</g>
${legend || `<text x="${w / 2}" y="130" text-anchor="middle" font-size="12" fill="${C.muted}">no public code yet</text>`}`;
  return frame(w, h, `~/${user.login} — top languages`, body, 'Most used languages');
}

function streakCard({ user, years, days }) {
  const s = streaks(days);
  const total = years.reduce((sum, y) => sum + y.total, 0);
  const w = 900, h = 200, col = w / 3;
  const block = (cx, value, label, sub, color, i) => `<g>
  <text x="${cx}" y="104" text-anchor="middle" font-size="34" font-weight="700" fill="${color}">${esc(value)}</text>
  <text x="${cx}" y="140" text-anchor="middle" font-size="13" fill="${C.text}">${esc(label)}</text>
  <text x="${cx}" y="162" text-anchor="middle" font-size="11" fill="${C.muted}">${esc(sub)}</text>
</g>`;
  const curSub = s.current ? `${shortDate(s.currentStart)} - ${shortDate(s.currentEnd)}` : 'start one today';
  const body = [
    block(col / 2, fmt(total), 'Total Contributions', `${shortDate(days[0]?.date)} - Present`, C.title, 0),
    `<line x1="${col}" y1="55" x2="${col}" y2="170" stroke="${C.border}"/>`,
    `<circle cx="${col * 1.5}" cy="92" r="34" fill="none" stroke="${C.accent}" stroke-width="4"/>`,
    block(col * 1.5, fmt(s.current), 'Current Streak', curSub, C.accent, 1),
    `<line x1="${col * 2}" y1="55" x2="${col * 2}" y2="170" stroke="${C.border}"/>`,
    block(col * 2.5, fmt(s.longest), 'Longest Streak', s.longest ? `${shortDate(s.longestStart)} - ${shortDate(s.longestEnd)}` : '-', C.orange, 2),
  ].join('\n');
  return frame(w, h, `~/${user.login} — streak`, body, 'Contribution streak');
}

const TROPHIES = [
  // [title, levels C..S]
  ['Commits', [1, 10, 100, 200, 500, 1000]],
  ['Repositories', [1, 5, 10, 20, 30, 50]],
  ['Stars', [1, 10, 30, 50, 100, 200]],
  ['Followers', [1, 10, 20, 50, 100, 200]],
  ['Pull Requests', [1, 10, 20, 50, 100, 200]],
  ['Issues', [1, 10, 20, 50, 100, 200]],
  ['Experience', [1, 2, 3, 4, 5, 10]],
];
const RANKS = [['C', '#9e9e9e'], ['B', C.blue], ['A', C.title], ['AA', C.orange], ['AAA', C.accent], ['S', '#ffd700']];

function trophyCard({ user, repos, years }) {
  const values = {
    Commits: years.reduce((s, y) => s + y.commits, 0),
    Repositories: user.repositories.totalCount,
    Stars: repos.reduce((s, r) => s + r.stargazerCount, 0),
    Followers: user.followers.totalCount,
    'Pull Requests': user.pullRequests.totalCount,
    Issues: user.issues.totalCount,
    Experience: Math.floor((Date.now() - new Date(user.createdAt)) / (365.25 * 864e5)),
  };
  const tile = 120, gap = 8, w = TROPHIES.length * (tile + gap) - gap + 40, h = 200;
  const tiles = TROPHIES.map(([name, levels], i) => {
    const v = values[name];
    const lvl = levels.reduce((acc, t, k) => (v >= t ? k : acc), -1);
    const [rank, color] = lvl >= 0 ? RANKS[lvl] : ['?', C.border];
    const x = 20 + i * (tile + gap), cx = x + tile / 2;
    const unit = name === 'Experience' ? (v === 1 ? 'yr' : 'yrs') : '';
    return `<g>
  <rect x="${x}" y="46" width="${tile}" height="138" rx="6" fill="${C.bar}" stroke="${C.border}"/>
  <g transform="translate(${cx} 92)" fill="${color}" stroke="${color}">
    <path d="M-17 -26h34v12a17 17 0 0 1-34 0z" stroke="none"/>
    <path d="M-17 -22h-7a7 7 0 0 0 7 13M17 -22h7a7 7 0 0 1-7 13" fill="none" stroke-width="3"/>
    <rect x="-3" y="2" width="6" height="9" stroke="none"/>
    <rect x="-12" y="11" width="24" height="5" rx="1.5" stroke="none"/>
  </g>
  <text x="${cx}" y="${92 - 11}" text-anchor="middle" font-size="12" font-weight="700" fill="${C.bg}">${rank}</text>
  <text x="${cx}" y="140" text-anchor="middle" font-size="12" fill="${C.text}">${esc(name)}</text>
  <text x="${cx}" y="164" text-anchor="middle" font-size="12" font-weight="700" fill="${color === C.border ? C.muted : color}">${fmt(v)}${unit ? ' ' + unit : ''}</text>
</g>`;
  }).join('\n');
  return frame(w, h, `~/${user.login} — trophies`, tiles, 'GitHub trophies');
}

function activityCard({ user, days }) {
  const last = days.slice(-31);
  const w = 900, h = 300, pl = 50, pr = 24, pt = 56, pb = 44;
  const pw = w - pl - pr, ph = h - pt - pb;
  const max = Math.max(4, ...last.map((d) => d.count));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const X = (i) => pl + (last.length > 1 ? (i / (last.length - 1)) * pw : pw / 2);
  const Y = (v) => pt + ph - (v / top) * ph;
  const pts = last.map((d, i) => [X(i), Y(d.count)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  const area = `${line}L${X(last.length - 1).toFixed(1)} ${pt + ph}L${pl} ${pt + ph}Z`;
  const grid = [0, 1, 2, 3, 4].map((k) => {
    const y = Y(k * step);
    return `<line x1="${pl}" y1="${y}" x2="${w - pr}" y2="${y}" stroke="${C.border}" stroke-dasharray="${k ? '3 4' : ''}"/>
<text x="${pl - 10}" y="${y + 4}" text-anchor="end" font-size="10" fill="${C.muted}">${k * step}</text>`;
  }).join('\n');
  const xl = last.map((d, i) => `<text x="${X(i)}" y="${h - pb + 18}" text-anchor="middle" font-size="10" fill="${C.muted}">${+d.date.slice(8)}</text>`).join('');
  const dots = pts.map(([x, y], i) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${C.bg}" stroke="${C.title}" stroke-width="2"><title>${last[i].date}: ${last[i].count}</title></circle>`).join('');
  const body = `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="${C.title}" stop-opacity=".35"/><stop offset="1" stop-color="${C.title}" stop-opacity="0"/>
</linearGradient></defs>
${grid}
${xl}
<g><path d="${area}" fill="url(#g)"/><path d="${line}" fill="none" stroke="${C.title}" stroke-width="2" stroke-linejoin="round"/>${dots}</g>`;
  const range = last.length ? `${shortDate(last[0].date)} - ${shortDate(last[last.length - 1].date)}` : '';
  return frame(w, h, `~/${user.login} — contributions · ${range}`, body, 'Contribution activity, last 31 days');
}

// ---------------------------------------------------------------- main

async function main() {
  if (!TOKEN) throw new Error('GITHUB_TOKEN is not set');
  const { user, repos } = await fetchProfile();
  const { years, days } = await fetchYears(user.createdAt);
  const data = { user, repos, years, days, langs: languages(repos) };
  const cards = {
    'stats.svg': statsCard(data),
    'top-langs.svg': langsCard(data),
    'streak.svg': streakCard(data),
    'trophies.svg': trophyCard(data),
    'activity.svg': activityCard(data),
  };
  await mkdir(OUT, { recursive: true });
  for (const [name, svg] of Object.entries(cards)) {
    await writeFile(new URL(name, OUT), svg);
    console.log(`wrote assets/${name}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
