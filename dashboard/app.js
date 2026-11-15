// Token Radar v2 dashboard. Reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the ranked board, filters, a detail drawer with the
// full model breakdown, and farm plans. No network: all data is in data.js.
// The model functions below mirror lib/model.ts exactly, so the page can
// recompute any row and check it against the number board.json carries.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };
  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) { return (n === null || n === undefined || !isFinite(n)) ? 'n/a' : (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(d)) + 'd';
  }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  // The comparables model, recomputed from the row's own snapshot figures.
  function impliedOf(row, model) {
    var growth = clamp(row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d, model.growth_floor, model.growth_cap);
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (clamp(age, 0, model.maturity_days) / model.maturity_days) * model.maturity_range;
    var chainMult = 1 + Math.min(Math.max((row.chains ? row.chains.length : 1) - 1, 0), model.chain_max_extra) * model.chain_step;
    var f = growthMult * maturity * chainMult;
    return {
      base: Math.max(1, Math.round(row.tvl_usd * row.multiple_p50 * f)),
      low: Math.max(1, Math.round(row.tvl_usd * row.multiple_p25 * f)),
      high: Math.max(1, Math.round(row.tvl_usd * row.multiple_p75 * f)),
      growthMult: growthMult, maturity: maturity, chainMult: chainMult, growth: growth
    };
  }
  function radarScoreOf(row, model) {
    var v = impliedOf(row, model);
    var logPart = clamp((Math.log10(Math.max(v.base, 1)) - 6) / 3.5, 0, 1) * 100;
    var growthPart = clamp(50 + v.growth * 0.4, 0, 100);
    var agePart = clamp((row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days) / model.maturity_days, 0, 1) * 100;
    var stability = (row.change_7d === null || row.change_7d === undefined) ? 60 : clamp(100 - Math.abs(row.change_7d) * 1.2, 0, 100);
    var chainPart = clamp((row.chains ? row.chains.length : 0) / 8, 0, 1) * 100;
    return Math.round(0.4 * logPart + 0.2 * growthPart + 0.15 * agePart + 0.15 * stability + 0.1 * chainPart);
  }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i]; if (c === null || c === undefined) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(x); });
      else if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    }
    return node;
  }
  // Farm plans: the same derivation lib/model.ts writes to board.json.
  function chainOf(p) { return p.chains && p.chains.length ? p.chains[0] : 'its main chain'; }
  function secondChain(p) { return p.chains && p.chains.length > 1 ? p.chains[1] : chainOf(p); }
  function gasFor(chain) { if (chain === 'Ethereum') return 12; if (chain === 'Solana' || chain === 'Bitcoin') return 2; return 3; }
  function capitalFor(p) { if (p.tvl_usd >= 5e9) return 250; if (p.tvl_usd >= 1e9) return 150; if (p.tvl_usd >= 1e8) return 100; return 50; }
  function holdDaysFor(age) { if (age === null || age === undefined) return 30; if (age < 180) return 60; if (age < 365) return 45; return 30; }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase(); var n = p.name;
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' into a top ' + n + ' curated vault on ' + chain + ', picking the vault whose curator publishes its allocation rules, and keep the vault shares in the farm wallet.';
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0 || c.indexOf('uncollateralized') >= 0) return 'Supply $' + capital + ' of USDC as collateral to ' + n + ' on ' + chain + ', then borrow at most 30% against it so the health factor stays comfortably above liquidation.';
    if (c.indexOf('restak') >= 0) return 'Restake $' + capital + ' worth of the liquid staking token ' + n + ' accepts on ' + chain + ' and keep the restaking receipt; do not loop it into a second restaking layer.';
    if (c.indexOf('liquid staking') >= 0 || c.indexOf('staking pool') >= 0 || c.indexOf('staking') >= 0) return 'Stake $' + capital + ' worth of the native asset through ' + n + ' on ' + chain + ' and hold the liquid receipt token in the farm wallet.';
    if (c.indexOf('bridge') >= 0 || c.indexOf('canonical') >= 0) return 'Bridge $' + capital + ' of USDC from Ethereum to ' + chain + ' through ' + n + ', then make one real use of the bridged funds (a swap or a deposit) on the destination chain.';
    if (c.indexOf('dex') >= 0) return 'Add $' + capital + " as two-sided liquidity to " + n + "'s highest-volume stable or major pair on " + chain + ', then make one swap through the same pool so both sides of the venue see the wallet.';
    if (c.indexOf('derivative') >= 0 || c.indexOf('perpetual') >= 0 || c.indexOf('interest rate') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + n + ' (' + chain + '), open one small hedged position (long and short legs of equal size) and close it after a day, keeping total fees under $5.';
    if (c.indexOf('basis') >= 0) return "Open " + n + "'s basis position with $" + capital + ' on ' + chain + ': hold the spot leg and the offsetting short leg together, and check the funding rate before entering.';
    if (c.indexOf('yield') >= 0 || c.indexOf('farm') >= 0 || c.indexOf('liquidity manager') >= 0) return 'Deposit $' + capital + ' into ' + n + "'s main vault on " + chain + ' and leave auto-compounding on; note the vault\'s lock or cooldown period in the farm log before depositing.';
    if (c.indexOf('rwa') >= 0) return "Complete " + n + "'s onboarding on " + chain + ' if it asks for it, then mint $' + capital + ' of its yield-bearing asset and hold it; keep the mint receipt and terms in the farm log.';
    if (c.indexOf('insurance') >= 0) return 'Split the position: buy $' + Math.max(25, Math.floor(capital / 2)) + ' of cover from ' + n + ' on ' + chain + ' for a position you actually hold, and keep the policy NFT or receipt until it expires.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' on ' + n + ' and place two small positions on liquid markets you can price yourself; avoid illiquid markets where the spread eats the position.';
    if (c.indexOf('stable') >= 0 || c.indexOf('cedefi') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + n + ' on ' + chain + ', then provide half of it as liquidity against USDC so the wallet both mints and trades it.';
    if (c.indexOf('chain') >= 0) return 'Bridge $' + capital + ' to ' + n + "'s chain, make three ordinary transactions there (a transfer, a swap, a contract call) on different days, and keep a small native balance for gas.";
    if (c.indexOf('privacy') >= 0) return 'Deposit $' + capital + ' through ' + n + ' on ' + chain + ' using its standard denomination, wait at least a day, then withdraw to a fresh address from the same wallet set.';
    if (c.indexOf('index') >= 0) return 'Buy $' + capital + ' of ' + n + "'s index basket on " + chain + ' and hold it; rebalance only when the protocol itself rebalances the basket.';
    return 'Deposit $' + capital + ' of USDC into ' + n + ' on ' + chain + ' through its main app flow and keep the position open; if the app offers a points or rewards page, opt in there first.';
  }
  function weeklyFor(p, chain) {
    var c = (p.category || '').toLowerCase(); var n = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0) return 'Once a week on ' + chain + ', adjust the ' + n + ' position once: repay a slice and re-borrow, or top collateral up by $10, so the wallet shows recurring lending activity, not a single deposit.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('farm') >= 0 || c.indexOf('liquidity') >= 0) return 'Once a week, make one swap of $20-30 through ' + n + ' on ' + chain + ' and harvest or restake any rewards the position earned, keeping gas below the reward value.';
    if (c.indexOf('derivative') >= 0 || c.indexOf('perpetual') >= 0 || c.indexOf('basis') >= 0) return 'Once a week, open and close one small hedged trade on ' + n + ' so volume accrues steadily; stop for the week if cumulative fees pass $10.';
    if (c.indexOf('bridge') >= 0 || c.indexOf('canonical') >= 0 || c.indexOf('chain') >= 0) return 'Once a week, bridge a small amount ($20-30) in the other direction through ' + n + ' or make one transaction on ' + chain + ', varying the day and amount so the pattern reads as real use.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'Once a week, check the ' + n + ' vault or staking position on ' + chain + ', claim any rewards it issued, and restake or compound them in the same wallet.';
    return 'Once a week, make one qualifying action in ' + n + ' on ' + chain + ' (a deposit, a swap, a vote or a claim, whichever its app counts) and record it in the farm log with the transaction hash.';
  }
  function stepText(s) { var t = s.text + ' Cost: ' + s.cost + '. Time: ' + s.time + '.'; if (t.length > 600) t = t.slice(0, 596) + '...'; if (t.length < 20) t += " Hold the position and check the protocol's own page."; return t; }
  function farmSteps(p) {
    var chain = chainOf(p), chain2 = secondChain(p), capital = capitalFor(p), hold = holdDaysFor(p.age_days), gas = gasFor(chain);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm with ' + p.name + ', fund it on ' + chain + ', and keep its seed phrase offline.', cost: 'about $' + gas + ' of gas to fund and approve', time: '5 minutes' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital plus about $' + gas + ' of gas', time: '15 minutes to set up' },
      { text: weeklyFor(p, chain2), cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Hold the ' + p.name + ' position for at least ' + hold + ' days, checking once a week that TVL and the app are unchanged; if the protocol announces a snapshot or points season, hold until it closes.', cost: 'the $' + capital + ' stays in the position for ' + hold + ' days', time: hold + ' days' },
      { text: "Before withdrawing, open " + p.name + "'s own points or rewards page and claim only from the link it publishes; log the wallet, dates, chains (" + ((p.chains && p.chains.slice(0, 3).join(', ')) || chain) + ') and every transaction hash so the position can be repeated or unwound.', cost: 'no fee to check, and never pay to claim', time: '10 minutes' }
    ].map(stepText);
  }
  function readHash() {
    var h = window.location.hash.replace(/^#/, ''); if (!h) return;
    var q = new URLSearchParams(h);
    if (q.get('q')) state.q = q.get('q');
    if (q.get('p')) state.selected = q.get('p');
    if (q.get('category')) state.category = q.get('category');
    if (q.get('chain')) state.chain = q.get('chain');
    if (q.get('tab')) state.tab = q.get('tab');
  }
  function writeHash() {
    var q = new URLSearchParams();
    if (state.q) q.set('q', state.q);
    if (state.category !== 'all') q.set('category', state.category);
    if (state.chain !== 'all') q.set('chain', state.chain);
    if (state.selected) q.set('p', state.selected);
    var s = q.toString();
    window.history.replaceState(null, '', s ? '#' + s : window.location.pathname + window.location.search);
  }
  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category || '', (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? -Infinity : a.age_days; bv = b.age_days === null ? -Infinity : b.age_days; }
      else if (key === 'score') { av = a.radar_score; bv = b.radar_score; }
      else if (key === 'rank') { av = a.rank; bv = b.rank; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir; if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : 1;
    });
  }
  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar' })),
      el('div', { class: 'top-meta' }, el('span', { text: 'Snapshot ' + DATA.as_of }), el('span', { text: 'DefiLlama index' }), el('span', { text: DATA.model_version + ' model' })));
  }
  function lede() {
    var top = DATA.rows[0];
    return el('section', { class: 'lede' },
      el('div', null, el('h1', { text: DATA.watchlist_size + ' watchlist protocols, priced by their tokenized peers' }),
        el('p', { text: 'Every pre-token protocol is valued at the mcap/TVL multiples its own category already trades at, tilted by growth, age and chain breadth. Top of the board: ' + (top ? top.name + ' at ' + fmtUsd(top.implied_value_usd) + ' implied.' : '') + ' Implied value is a model, not a promise, and says nothing about whether a token will launch.' })),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below $50M floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token set aside' }), el('b', { text: String(DATA.live_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Tokenized comparables' }), el('b', { text: String(DATA.global_multiples.count) }))));
  }
  function controls() {
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (a, r) { return a.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    function makeSelect(id, label, allLabel, values, cur, fn) {
      var s = el('select', { id: id, 'aria-label': label }, el('option', { value: 'all', text: allLabel }), values.map(function (v) { return el('option', { value: v, text: v, selected: v === cur ? 'selected' : null }); }));
      s.addEventListener('change', function () { fn(s.value); writeHash(); render(); });
      return el('div', { class: 'field' }, el('label', { for: id, text: label }), s);
    }
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      makeSelect('category', 'Category', 'All categories', cats, state.category, function (v) { state.category = v; }),
      makeSelect('chain', 'Chain', 'All chains', chains, state.chain, function (v) { state.chain = v; }),
      el('div', { class: 'field' }, el('span', { class: 'lab', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' rows shown' : DATA.live.length + ' live protocols' }));
  }
  function sortHeader(key, label) {
    return el('th', { scope: 'col' }, el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = key === 'name' ? 1 : -1; } render(); } }, label, state.sort === key ? el('span', { text: state.dir < 0 ? ' v' : ' ^' }) : null));
  }
  function boardTable() {
    var list = sortedRows(rows());
    if (!list.length) return el('div', { class: 'panel' }, el('div', { class: 'empty' }, el('h2', { text: 'No protocol matches that filter' }), el('p', { text: 'Clear the search or pick another category or chain.' }), el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; writeHash(); render(); } })));
    var maxScore = 100;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var tr = el('tr', { 'data-selected': state.selected === r.slug ? 'true' : 'false', tabindex: '0', onclick: function () { openDetail(r.slug); }, onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } } },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') : 'no chain listed') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' }, el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) }), el('span', { class: 'range', text: fmtUsd(r.implied_low_usd) + ' – ' + fmtUsd(r.implied_high_usd) }))),
        el('td', null, el('div', { class: 'score' }, el('span', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round(r.radar_score / maxScore * 100)) + '%' })), el('b', { text: String(r.radar_score) }))),
        el('td', null, el('span', { class: 'pill', text: 'pre-token' })));
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' }, el('table', null,
      el('caption', { text: 'Pre-token protocols ranked by implied value (base case). Select a row for its model breakdown and farm plan.' }),
      el('thead', null, el('tr', null, sortHeader('rank', 'Rank'), sortHeader('name', 'Protocol'), sortHeader('tvl', 'TVL'), sortHeader('growth', '7d'), sortHeader('age', 'Age'), sortHeader('implied', 'Implied value'), sortHeader('score', 'Score'), el('th', { scope: 'col', text: 'Token' }))), tbody)));
  }
  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : '') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', { class: 'num', text: r.tvl_usd && r.mcap_usd ? (r.mcap_usd / r.tvl_usd).toFixed(2) + 'x' : 'n/a' }),
        el('td', null, el('span', { class: 'pill live', text: 'trades' }))));
    });
    return el('div', { class: 'panel' }, el('div', { class: 'table-wrap' }, el('table', null,
      el('caption', { text: 'Already tokenized: market cap is a fact, not a model. These protocols are the comparables that price the pre-token board; they are never ranked with it.' }),
      el('thead', null, el('tr', null, el('th', { text: 'Status' }), el('th', { text: 'Protocol' }), el('th', { text: 'TVL' }), el('th', { text: '7d' }), el('th', { text: 'Market cap' }), el('th', { text: 'Mcap/TVL' }), el('th', { text: 'Token' }))), tbody)));
  }
  function methodPanel() {
    var m = DATA.model, g = DATA.global_multiples;
    return el('section', { class: 'panel method' },
      el('h2', { text: 'Methodology — how implied value is computed' }),
      el('p', { text: 'Comparables first: take every tokenized protocol in the snapshot (' + g.count + ' with a positive market cap; a recorded $0 cap is missing data, not a price), group by category, and read the 25th, 50th and 75th percentile of market cap divided by TVL. Globally those are ' + g.p25 + 'x, ' + g.p50 + 'x and ' + g.p75 + 'x. A category with at least ' + m.min_comps + ' tokenized peers uses its own multiples; the rest use the global ones. No name is hand-picked or hard-coded.' }),
      el('div', { class: 'formula', text: 'implied = TVL x category p50 x (1 + clamp(7d growth, ' + m.growth_floor + ', ' + m.growth_cap + ')/100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age, ' + m.maturity_days + ')/' + m.maturity_days + ' x ' + m.maturity_range + ') x (1 + min(chains-1, ' + m.chain_max_extra + ') x ' + m.chain_step + ')   ·   low/high use p25/p75 instead of p50' }),
      el('p', { text: 'Radar score (0-100) blends log implied value (40%), 7d growth (20%), age with no token (15%), TVL stability (15%, falling as |7d change| grows) and chain breadth (10%). Board rank is by implied value; the score is the quick signal. Farm plans are generated per protocol from its category, chains, TVL tier and age — the same code writes board.json and renders this page, and the detail view recomputes each row live so you can verify the arithmetic.' }));
  }
  var dialog = el('dialog', { class: 'detail', id: 'detail' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); render(); });
  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug; writeHash();
    var v = impliedOf(row, DATA.model);
    var score = radarScoreOf(row, DATA.model);
    var steps = farmSteps(row);
    dialog.textContent = '';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null, el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + ' · Score ' + row.radar_score }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'no chain listed') })),
      el('button', { class: 'close', type: 'button', text: 'Close', onclick: function () { dialog.close(); } })));
    dialog.appendChild(el('section', { class: 'detail-section' }, el('h3', { text: 'Why this value — model breakdown' }),
      el('div', { class: 'eq' },
        el('div', null, el('span', { text: 'TVL (snapshot)' }), el('b', { text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Category multiple p25 / p50 / p75' }), el('b', { text: row.multiple_p25.toFixed(4) + 'x / ' + row.multiple_p50.toFixed(4) + 'x / ' + row.multiple_p75.toFixed(4) + 'x' })),
        el('div', null, el('span', { text: 'Comparables used' }), el('b', { text: row.comps_count + ' (' + row.comps_source + ')' })),
        el('div', null, el('span', { text: '7d growth -> multiplier' }), el('b', { text: fmtPct(row.change_7d) + ' -> ' + row.growth_multiplier + 'x' })),
        el('div', null, el('span', { text: 'Age ' + fmtAge(row.age_days) + ' -> maturity' }), el('b', { text: row.maturity_multiplier + 'x' })),
        el('div', null, el('span', { text: 'Chains ' + (row.chains ? row.chains.length : 0) + ' -> breadth' }), el('b', { text: row.chain_multiplier + 'x' })),
        el('div', null, el('span', { text: 'Implied range (p25-p75)' }), el('b', { text: fmtUsd(row.implied_low_usd) + ' – ' + fmtUsd(row.implied_high_usd) })),
        el('div', { class: 'total' }, el('span', { text: 'Implied value (base)' }), el('b', { text: fmtUsd(row.implied_value_usd) }))),
      el('p', { class: 'sub', text: 'This page recomputes the row as ' + fmtUsd(v.base) + ' with score ' + score + (v.base === row.implied_value_usd && score === row.radar_score ? ' — identical to board.json.' : ' — differs from board.json, so the data would be stale.') + ' Estimate only: it assumes peers keep their current pricing and says nothing about whether a token launches.' })));
    dialog.appendChild(el('section', { class: 'detail-section' }, el('h3', { text: 'Snapshot facts' }),
      el('div', { class: 'eq' },
        el('div', null, el('span', { text: 'Slug' }), el('b', { text: row.slug })),
        el('div', null, el('span', { text: 'Listed since' }), el('b', { text: row.listed_at || 'unknown' })),
        el('div', null, el('span', { text: 'Token status' }), el('b', { text: 'pre-token (no token on record)' })))));
    dialog.appendChild(el('section', { class: 'detail-section' }, el('h3', { text: 'Farm plan — 5 steps' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: '); var a = at >= 0 ? s.slice(0, at) : s; var t = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: a }), el('span', { class: 'cost', text: t }));
      }))));
    if (!dialog.isConnected) app.appendChild(dialog);
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); } else dialog.setAttribute('open', '');
    renderTableOnly();
  }
  function renderTableOnly() { /* detail opens over the board; board stays as rendered */ }
  function render() {
    var selected = state.selected;
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header()); shell.appendChild(lede()); shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(methodPanel());
    app.appendChild(shell); app.appendChild(dialog);
    app.setAttribute('aria-busy', 'false');
    if (selected) { state.selected = selected; var r = DATA.rows.filter(function (x) { return x.slug === selected; })[0]; if (r && !dialog.open) openDetail(selected); }
  }
  readHash(); render();
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialog.open) dialog.close(); });
})();
