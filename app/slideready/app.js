/* Slide readability web app. Plain React + Ant Design from CDN, no build step. */
const html = htm.bind(React.createElement);
const {useState, useMemo, useRef, useEffect, useLayoutEffect} = React;
const {ConfigProvider, App: AntApp, Upload, Radio, Button, Segmented, Select, Spin, Alert, Collapse, Space} = antd;

/* ---------- room choices shown to people ---------- */
const WHERE = {room:{label:'In the room', sub:'Everyone is there in person'}, online:{label:'Online', sub:'Video call or webinar'}, both:{label:'Both', sub:'In the room and streamed'}};
const ROOMS = {
  small:{label:'Small room', sub:'Up to 30 people', depth:25, floor:'flat'},
  medium:{label:'Medium room', sub:'About 100 people', depth:60, floor:'flat'},
  large:{label:'Large hall', sub:'About 300 people', depth:110, floor:'flat'},
  huge:{label:'Auditorium or stage', sub:'500 or more, sloped seats, LED wall', depth:150, floor:'sloped'},
};
const AGES = {u40:'Under 40', '40s':'40 to 59', '60s':'60 to 74', '75':'75 or older'};
const LIGHTS = {dark:'Dark', dimmed:'Dimmed', on:'Lights on', day:'Daylight'};
const IMPACT = {high:'Most of the room', some:'Some people', minor:'Minor'};
const CATS = {see:'See', read:'Read', color:'Color', follow:'Follow'};
const band = s => s >= 85 ? {label:'Ready for this room', color:'var(--good)'} : s >= 65 ? {label:'Needs a few fixes', color:'var(--some)'} : {label:'Needs work', color:'var(--high)'};
const rowFt = r => 10 + (r - 1) * 3;
const rowOf = ft => Math.max(1, Math.round((ft - 10) / 3) + 1);

// Set by config.js on the published site; empty means the local server on the same origin.
const API = (window.SLIDEREADY_API || '').replace(/\/$/, '');
const CLOUD = !!API;
const track = (name, params) => { try { window.gtag && window.gtag('event', name, params || {}); } catch (e) {} };

class ApiError extends Error { constructor(body, status) { super(body.message || body.error || body.detail || `Request failed (${status})`); this.body = body; this.status = status; } }
async function api(path, opts = {}) {
  const res = await fetch(API + path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body, res.status);
  return body;
}

// Published site: ask for an upload link, send the deck straight to S3, then run the check.
async function cloudCheck(file, venue) {
  const up = await jsonPost('/api/uploads', {filename:file.name, size:file.size});
  const fd = new FormData();
  Object.entries(up.upload.fields).forEach(([k, v]) => fd.append(k, v));
  fd.append('file', file);
  const s3 = await fetch(up.upload.url, {method:'POST', body:fd});
  if (!s3.ok) throw new ApiError({error:'The upload did not go through. Try again.'}, s3.status);
  return jsonPost(`/api/checks/${up.id}`, venue);
}
const jsonPost = (path, data) => api(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data)});

function useWidth() {
  const ref = useRef(null); const [w, setW] = useState(800);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current); return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/* ---------- room simulation on the real slide image ---------- */
const toLin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const toSrgb = l => { l = Math.max(0, Math.min(1, l)); return 255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055); };

// Map every pixel through the screen's light: lifted blacks, reduced range.
function washLut(room) {
  const n = room.white + room.ambient, lut = new Uint8ClampedArray(256);
  for (let c = 0; c < 256; c++) lut[c] = toSrgb((room.black + (room.white - room.black) * toLin(c) + room.ambient) / n);
  return lut;
}

function SlideCanvas({src, width, room, washout, filter, highlight, pins, onPin, heads, captions, pip}) {
  const canvas = useRef(null);
  const H = width * 9 / 16;
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = canvas.current; if (!c) return;
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      if (washout && room) {
        const d = ctx.getImageData(0, 0, c.width, c.height), lut = washLut(room), px = d.data;
        for (let i = 0; i < px.length; i += 4) { px[i] = lut[px[i]]; px[i + 1] = lut[px[i + 1]]; px[i + 2] = lut[px[i + 2]]; }
        ctx.putImageData(d, 0, 0);
      }
    };
    img.src = src;
  }, [src, washout, room && room.white, room && room.ambient]);
  const dz = heads && room ? room.dead_zone : 0;
  return html`<div className="slide" style=${{width, height:H}}>
    <canvas ref=${canvas} style=${{width:'100%', height:'100%', display:'block', filter}}></canvas>
    ${(highlight || []).map((b, i) => html`<div key=${i} className="hlbox" style=${{left:b.left * width - 4, top:b.top * H - 4, width:(b.right - b.left) * width + 8, height:(b.bottom - b.top) * H + 8}}></div>`)}
    ${dz > 0 && html`<${Heads} dz=${dz} width=${width} height=${H}/>`}
    ${captions && html`<div className="captions" style=${{fontSize:Math.max(9, width / 44)}}>Live captions appear here</div>`}
    ${pip && html`<div className="pip">Speaker video</div>`}
    ${(pins || []).map(p => html`<button key=${p.n} className=${'pin ' + p.impact + (p.on ? ' on' : '')} style=${{left:p.x * width, top:p.y * H}} onClick=${() => onPin(p)} aria-label=${'Problem ' + p.n}>${p.n}</button>`)}
  </div>`;
}

function Heads({dz, width, height}) {
  const hz = dz * height, n = Math.max(5, Math.round(width / 80));
  const rows = [{cy:hz * .55, r:hz * .17, off:0, op:.42}, {cy:hz * .92, r:hz * .25, off:.5, op:.58}];
  return html`<div className="heads" style=${{height:hz}}>
    <div className="line"><span>Hidden past row 3</span></div>
    <svg width=${width} height=${hz} aria-hidden="true">${rows.map((r, ri) => Array.from({length:n + 1}, (_, i) => {
      const cx = (i + r.off) * width / n;
      return html`<g key=${ri + '-' + i} opacity=${r.op}><ellipse cx=${cx} cy=${r.cy} rx=${r.r * .82} ry=${r.r} fill="#1d2330"/><ellipse cx=${cx} cy=${r.cy + r.r * 1.95} rx=${r.r * 2.2} ry=${r.r * 1.25} fill="#1d2330"/></g>`;
    }))}</svg>
  </div>`;
}

const MODES = {
  laptop:{label:'Your laptop', cap:() => 'Your slide as it looks on your own screen.'},
  room:{label:'In the room', washout:true, heads:true, cap:r => `Projected in this room under its light.${r && r.dead_zone ? ' The amber line marks where heads block the view.' : ''}`},
  back:{label:'Back row', washout:true, heads:true, seat:true, filter:'blur(.6px)', cap:(r, seat) => `About how big the screen looks from row ${rowOf(seat)}.`},
  older:{label:'Older eyes', washout:true, filter:'url(#f-old) blur(.5px)', cap:() => 'Through an older lens: less blue, less contrast, softer focus.'},
  cvd:{label:'Color blind', filter:'url(#f-deut)', cap:() => 'Deuteranopia, the most common type of color blindness.'},
  stream:{label:'On the stream', filter:'blur(.4px)', pip:true, cap:() => 'A 720p stream with the speaker video in the corner.'},
};

/* ---------- screens ---------- */
function Pick({items, value, onChange, art}) {
  return html`<div className="profiles" role="radiogroup">${Object.entries(items).map(([k, it]) => html`<div key=${k} role="radio" aria-checked=${value === k} tabIndex=${0}
      className=${'profile' + (value === k ? ' on' : '')} onClick=${() => onChange(k)} onKeyDown=${e => e.key === 'Enter' && onChange(k)}>
      ${art && art(k)}<b>${it.label}</b><span>${it.sub}</span></div>`)}</div>`;
}

function RoomArt({k}) {
  const r = ROOMS[k], span = 160, w = 190, kx = (w - 12) / span, kv = kx * 2.4;
  const floorAt = x => r.floor === 'flat' ? 0 : Math.max(0, x - 10) * .12;
  const rows = []; for (let x = 10; x <= r.depth; x += 3) rows.push(x);
  const H = Math.round(8 + 22 * kv);
  const X = f => 6 + f * kx, Y = f => H - 4 - f * kv;
  return html`<svg width=${w} height=${H} aria-hidden="true">
    <rect x=${X(.6)} y=${Y(4 + (r.depth / 12))} width="2" height=${(r.depth / 12) * kv} fill="#151a22"/>
    ${rows.map(x => html`<circle key=${x} cx=${X(x)} cy=${Y(floorAt(x) + 4.1)} r="1.2" fill="#8b93a1"/>`)}
    <line x1=${X(0)} y1=${Y(0)} x2=${X(r.depth + 4)} y2=${Y(floorAt(r.depth + 4))} stroke="#c4cad4"/>
  </svg>`;
}

function SetupStep({venue, setVenue, onRun, busy, error, fileName}) {
  const set = k => v => setVenue({...venue, [k]:v});
  const inRoom = venue.where !== 'online';
  return html`<div className="intake">
    <h1>Tell us about the talk</h1>
    ${fileName && html`<p className="note">Checking ${fileName}</p>`}
    <div className="q"><h2>Where will people watch?</h2><${Pick} items=${WHERE} value=${venue.where} onChange=${set('where')}/></div>
    ${inRoom && html`<div className="q"><h2>How big is the room?</h2><${Pick} items=${ROOMS} value=${venue.room} onChange=${set('room')} art=${k => html`<${RoomArt} k=${k}/>`}/></div>`}
    <div className="q"><h2>How old is the oldest person likely to be there?</h2>
      <${Radio.Group} optionType="button" size="large" value=${venue.oldest} onChange=${e => set('oldest')(e.target.value)} options=${Object.entries(AGES).map(([value, label]) => ({value, label}))}/>
      <span className="note">${venue.oldest === 'u40' ? 'Younger eyes. Standard text sizes work.' : 'Older eyes need bigger text and stronger colors. We will plan for them.'}</span>
    </div>
    ${inRoom && html`<${Collapse} ghost items=${[{key:'a', label:'Fine tune the room (optional)', children:html`<div className="q"><h2>Room light</h2>
      <${Radio.Group} optionType="button" value=${venue.light} onChange=${e => set('light')(e.target.value)} options=${Object.entries(LIGHTS).map(([value, label]) => ({value, label}))}/></div>`}]}/>`}
    ${error && html`<${Alert} type="error" showIcon message=${error}/>`}
    <div className="actions"><${Button} type="primary" size="large" loading=${busy} onClick=${onRun}>${busy ? 'Checking slides' : 'See results'}<//>
      ${busy && html`<span className="note">Rendering every slide and checking it for this room. Usually 15 to 45 seconds.</span>`}</div>
  </div>`;
}

function QuotaNote({quota}) {
  return html`<div className="hero"><div>
    <h1>${quota.title}</h1>
    <p className="lead">${quota.message}</p>
  </div></div>`;
}

function UploadStep({onFile, onSample, samples}) {
  return html`<div className="hero">
    <div>
      <h1>Check your slides before you present</h1>
      <p className="lead">See your deck the way the back row, older guests and online viewers will, and find what they would miss.</p>
      <${Upload.Dragger} accept=".pptx,.ppt,.pdf" showUploadList=${false} beforeUpload=${f => { onFile(f); return false; }}>
        <p style=${{fontSize:15, fontWeight:500, margin:'16px 0 4px'}}>Drop a PowerPoint or PDF</p>
        <p className="note" style=${{marginBottom:16}}>or click to choose a file, up to 20 MB and 40 slides</p>
      <//>
      <div style=${{marginTop:16, display:'flex', gap:8, flexWrap:'wrap', alignItems:'center'}}>
        <span className="note">Or try a sample:</span>
        ${samples.map(s => html`<${Button} key=${s} onClick=${() => onSample(s)}>${s.replace('.pptx', '')}<//>`)}
      </div>
      <p className="note" style=${{marginTop:20}}>Slides are checked by an AI service and deleted after 24 hours. Nothing is kept or shared.</p>
    </div>
  </div>`;
}

function ResultsStep({deck, setDeck, venue, onChangeRoom}) {
  const rep = deck.report, room = rep.room;
  const [cur, setCur] = useState(0);
  const [mode, setMode] = useState(venue.where === 'online' ? 'stream' : 'room');
  const [seat, setSeat] = useState(rowFt(room ? room.rows : 1));
  const [hl, setHl] = useState(null);
  const [stageRef, stageW] = useWidth();
  useEffect(() => { setMode(venue.where === 'online' ? 'stream' : 'room'); setHl(null); }, [venue.where]);
  useEffect(() => { if (room) setSeat(rowFt(room.rows)); }, [room && room.rows]);

  const imgUrl = x => x.image_url || `/api/decks/${deck.id}/${x.image}`;
  const s = rep.slides[cur], img = imgUrl(s);
  const findLine = text => s.lines.find(l => l.text === text);
  const pins = s.findings.map((f, i) => { const l = f.lines.length && findLine(f.lines[0]); return l ? {n:i + 1, x:l.left, y:l.top, impact:f.impact, key:i, on:hl === i} : null; }).filter(Boolean);
  const boxes = hl == null ? [] : (s.findings[hl] ? s.findings[hl].lines.map(findLine).filter(Boolean) : []);

  const MAIN = venue.where === 'online' ? ['laptop', 'stream'] : ['laptop', 'room', 'back'];
  const more = ['older', 'cvd', 'stream'].filter(k => !MAIN.includes(k) && (k !== 'stream' || venue.where !== 'room')).map(value => ({value, label:MODES[value].label}));
  const m = MODES[mode];
  const inner = Math.max(240, stageW - 48);
  let w = inner;
  if (m.seat && room) w = Math.min(inner, 2304 * room.screen_h / seat * 16 / 9);
  if (m.pip) w = Math.min(inner, 640);

  const map = rep.seat_map, last = map && map[map.length - 1];
  const clear = map ? (map.find(r => r.miss) ? map.find(r => r.miss).row - 1 : map.length) : null;
  const n = rep.slides.length, withIssues = rep.slides.filter(x => x.findings.some(f => f.impact !== 'minor')).length;
  const headline = !map ? (withIssues ? `${withIssues} of ${n} slides will be hard to follow online.` : 'Every slide works for online viewers.')
    : clear === map.length ? 'Every row can read every slide.'
    : clear === 0 ? `Even the front row will miss text on ${map[0].miss} ${map[0].miss === 1 ? 'slide' : 'slides'}.`
    : `Up to row ${clear}, everyone reads every slide. Further back, people miss text on ${last.miss} ${last.miss === 1 ? 'slide' : 'slides'}.`;
  const deckCats = Object.fromEntries(Object.keys(CATS).map(k => [k, Math.round(rep.slides.reduce((a, x) => a + x.categories[k], 0) / n)]));
  const tone = miss => miss === 0 ? 'good' : miss <= 2 ? 'some' : 'high';
  const b = band(rep.score);

  return html`<div className="review">
    <header className="rhead">
      <div className="rtitle">
        <h1>${headline}</h1>
        <p className="context">${rep.deck}. ${rep.venue_text}.<a role="button" tabIndex=${0} onClick=${onChangeRoom} onKeyDown=${e => e.key === 'Enter' && onChangeRoom()}>Change</a></p>
      </div>
      <div className="rscore">
        <div className="score"><b style=${{color:b.color}}>${rep.score}</b><span>score, ${b.label.toLowerCase()}</span></div>
        <div className="catline">${Object.entries(CATS).map(([k, l]) => html`<span key=${k}>${l} <b style=${{color:band(deckCats[k]).color}}>${deckCats[k]}</b></span>`)}</div>
      </div>
    </header>

    ${map && html`<section className="seatmap" aria-label="Readability from each row">
      <div className="sm-screen">Screen</div>
      <div className="sm-rows">${map.map(x => html`<button key=${x.row} className=${'sm-row ' + tone(x.miss) + (rowOf(seat) === x.row ? ' you' : '')}
          title=${x.miss ? `Row ${x.row}: text too small on ${x.miss} slides` : `Row ${x.row}: every slide readable`}
          onClick=${() => { setSeat(rowFt(x.row)); setMode('back'); }} aria-label=${'Sit in row ' + x.row}></button>`)}</div>
      <div className="sm-legend"><span>Row 1, front</span><span>Row ${last.row}, back</span></div>
      <div className="sm-key"><span><i className="good"></i>Reads everything</span><span><i className="some"></i>Misses 1 or 2 slides</span><span><i className="high"></i>Misses more</span></div>
    </section>`}

    <div className="workspace">
      <div className="stagecol">
        <div className="stagebar">
          <${Segmented} value=${MAIN.includes(mode) ? mode : null} onChange=${setMode} options=${MAIN.map(value => ({value, label:MODES[value].label}))}/>
          ${more.length > 0 && html`<${Select} placeholder="See it as" value=${MAIN.includes(mode) ? undefined : mode} onChange=${setMode} options=${more} style=${{minWidth:140}} allowClear onClear=${() => setMode(MAIN[1])}/>`}
          ${room && m.seat && html`<span className="note seatnote">Sitting in row ${rowOf(seat)}. Pick a row above to move.</span>`}
        </div>
        <div className="stagebox" ref=${stageRef}>
          <${SlideCanvas} src=${img} width=${w} room=${room} washout=${m.washout} filter=${m.filter} heads=${m.heads}
            captions=${false} pip=${m.pip} highlight=${boxes} pins=${pins} onPin=${p => setHl(p.key)}/>
        </div>
        <div className="cap">${m.cap(room, seat)}</div>
        <div className="film" role="list">
          ${rep.slides.map((x, i) => html`<div key=${x.image} role="listitem" tabIndex=${0} className=${'thumb' + (i === cur ? ' on' : '')}
              onClick=${() => { setCur(i); setHl(null); }} onKeyDown=${e => e.key === 'Enter' && (setCur(i), setHl(null))}>
            <img src=${imgUrl(x)} width="132" height="74" alt=${'Slide ' + (i + 1)} loading="lazy"/>
            <div className="meta"><span>${i + 1}</span><b style=${{color:band(x.score).color}}>${x.score}</b></div>
          </div>`)}
        </div>
      </div>

      <aside className="notes">
        <div className="panel-head"><h2>Slide ${cur + 1}</h2><span className="mono" style=${{color:band(s.score).color, fontWeight:600}}>${s.score}</span></div>
        ${s.findings.length === 0 && html`<div className="allclear">Everyone will see this slide clearly.</div>`}
        <ol className="flist">
          ${s.findings.map((f, i) => html`<li key=${i} tabIndex=${0} className=${'finding ' + f.impact + (hl === i ? ' sel' : '')}
              onClick=${() => setHl(hl === i ? null : i)} onKeyDown=${e => e.key === 'Enter' && setHl(hl === i ? null : i)}>
            <span className=${'num ' + f.impact}>${i + 1}</span>
            <div className="fbody">
              <div className="t">${f.title}</div>
              <p>${f.detail}</p>
              ${f.lines.length > 0 && html`<p className="quote">${f.lines.slice(0, 3).map(t => t.length > 48 ? t.slice(0, 47) + '…' : t).join(' / ')}${f.lines.length > 3 ? ` and ${f.lines.length - 3} more` : ''}</p>`}
              <div className="row"><span className="who">${IMPACT[f.impact]}: ${f.who.charAt(0).toLowerCase() + f.who.slice(1)}</span></div>
            </div>
          </li>`)}
        </ol>
      </aside>
    </div>
  </div>`;
}

function Main() {
  const [step, setStep] = useState(0);
  const [venue, setVenue] = useState({where:'room', room:'medium', oldest:'60s', light:'dimmed'});
  const [pending, setPending] = useState(null);      // {file} or {sample}
  const [deck, setDeck] = useState(null);            // {id, report}
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [samples, setSamples] = useState([]);
  const [quota, setQuota] = useState(null);           // {title, message} once the budget is used up
  useEffect(() => {
    if (CLOUD) { setSamples(['problems.pptx']); api('/api/status').then(s => setQuota(s.quota)).catch(() => {}); }
    else api('/api/options').then(o => setSamples(o.samples)).catch(() => {});
  }, []);

  const run = async () => {
    setBusy(true); setError(null);
    const t0 = Date.now();
    try {
      let res;
      if (deck && !pending) {
        res = await jsonPost(CLOUD ? `/api/checks/${deck.id}/report` : `/api/decks/${deck.id}/report`, venue);
        track('room_change', venue);
      } else if (CLOUD) {
        let file = pending.file;
        if (pending.sample) {
          const blob = await (await fetch(`samples/${pending.sample}`)).blob();
          file = new File([blob], pending.sample, {type: blob.type});
        }
        track('check_start', {sample: !!pending.sample, where: venue.where, room: venue.room});
        res = await cloudCheck(file, venue);
        res.report.deck = pending.sample ? `${pending.sample} (sample)` : res.report.deck;
        track('check_done', {score: res.report.score, slides: res.report.slides.length, seconds: Math.round((Date.now() - t0) / 1000)});
      } else if (pending.sample) res = await jsonPost(`/api/samples/${encodeURIComponent(pending.sample)}`, venue);
      else {
        const fd = new FormData(); fd.append('file', pending.file);
        Object.entries(venue).forEach(([k, v]) => fd.append(k, v));
        res = await api('/api/decks', {method:'POST', body:fd});
      }
      setDeck(res); setPending(null); setStep(2);
    } catch (e) {
      if (e.body && e.body.title) { setQuota(e.body); setStep(0); track('quota_hit'); }
      else { setError(e.message); track('check_error', {status: e.status || 0}); }
    }
    finally { setBusy(false); }
  };
  const tabs = ['Slides', 'Room', 'Results'];
  const canGo = i => i === 0 || (i === 1 && (pending || deck)) || (i === 2 && deck);
  return html`<div className="wrap">
    <div className="top">
      <div className="brand">Slide readability</div>
      <nav className="tabs">${tabs.map((l, i) => html`<button key=${l} className=${step === i ? 'on' : ''} disabled=${!canGo(i)} onClick=${() => canGo(i) && setStep(i)}>${l}</button>`)}</nav>
    </div>
    ${step === 0 && quota && html`<${QuotaNote} quota=${quota}/>`}
    ${step === 0 && !quota && html`<${UploadStep} samples=${samples} onFile=${f => { setPending({file:f}); setStep(1); }} onSample=${s => { setPending({sample:s}); setStep(1); }}/>`}
    ${step === 1 && html`<${SetupStep} venue=${venue} setVenue=${setVenue} onRun=${run} busy=${busy} error=${error}
        fileName=${pending ? (pending.file ? pending.file.name : pending.sample) : deck && deck.report.deck}/>`}
    ${step === 2 && deck && html`<${ResultsStep} deck=${deck} setDeck=${setDeck} venue=${venue} onChangeRoom=${() => setStep(1)}/>`}
  </div>`;
}

const theme = {token:{colorPrimary:'#2346c8', colorText:'#151a22', colorTextSecondary:'#5b6472', colorBorder:'#dde1e7', fontFamily:'"Geist", system-ui, sans-serif', fontSize:14, borderRadius:8, colorBgLayout:'#f6f7f9'}};
ReactDOM.createRoot(document.getElementById('root')).render(html`<${ConfigProvider} theme=${theme}><${AntApp}><${Main}/><//><//>`);
