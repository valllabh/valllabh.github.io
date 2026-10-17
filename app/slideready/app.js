/* SlideReady */
const html = htm.bind(React.createElement);
const {useState, useMemo, useRef, useEffect, useLayoutEffect} = React;
const {ConfigProvider, App: AntApp, Upload, Radio, Button, Segmented, Switch, Alert, Collapse, Space} = antd;

/* ---------- room choices shown to people ---------- */
const WHERE = {room:{label:'In the room', sub:'Everyone is there in person', icon:'where-room'}, online:{label:'Online', sub:'Zoom, Teams or a webinar', icon:'where-online'}, both:{label:'Both', sub:'In the room and on a call', icon:'where-both'}};
const ROOMS = {
  small:{label:'Small room', sub:'Up to 30 people', depth:25, floor:'flat', icon:'room-small'},
  medium:{label:'Medium room', sub:'About 100 people', depth:60, floor:'flat', icon:'room-medium'},
  large:{label:'Large hall', sub:'About 300 people', depth:110, floor:'flat', icon:'room-large'},
  huge:{label:'Auditorium or stage', sub:'500 or more, sloped seats, LED wall', depth:150, floor:'sloped', icon:'room-huge'},
};
const AGES = {
  u40:{label:'Under 40', sub:'Sharp eyes all round', icon:'age-u40'},
  '40s':{label:'40 to 59', sub:'Reading glasses on standby', icon:'age-40s'},
  '60s':{label:'60 to 74', sub:'Glasses on, front seats taken', icon:'age-60s'},
  '75':{label:'75 or older', sub:'Has seen every slide since overhead projectors', icon:'age-75'},
};
const ICON = name => `icons/${name}.png`;
const Icon = ({name, size = 104, className = 'icon'}) => html`<img className=${className} src=${ICON(name)} width=${size} height=${size} alt="" loading="lazy" decoding="async" draggable=${false}/>`;
const LIGHTS = {dark:'Dark', dimmed:'Dimmed', on:'Lights on', day:'Daylight'};
const CATS = {see:'See', read:'Read', color:'Color', follow:'Follow'};
const band = s => s >= 85 ? {label:'Ready for this room', color:'var(--good)'} : s >= 65 ? {label:'Needs a few fixes', color:'var(--some)'} : {label:'Needs work', color:'var(--high)'};
const rowFt = r => 10 + (r - 1) * 3;

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

// SHA-256 of the file, lowercase hex. Empty when the browser cannot hash (insecure origin).
async function sha256(file) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { return ''; }
}

// Published site: hash the deck, ask for an upload link (or reuse a report for the same file),
// send the deck straight to S3, then run the check.
async function cloudCheck(file, venue, onPhase = () => {}) {
  const hash = await sha256(file);
  const up = await jsonPost('/api/uploads', hash ? {filename:file.name, size:file.size, sha256:hash} : {filename:file.name, size:file.size});
  if (up.cached) {
    track('check_cached', {size: file.size});
    onPhase('uploaded', {cached:true});
    const res = await jsonPost(`/api/checks/${up.id}`, venue);
    res.cached = true;
    return res;
  }
  const fd = new FormData();
  Object.entries(up.upload.fields).forEach(([k, v]) => fd.append(k, v));
  fd.append('file', file);
  const s3 = await fetch(up.upload.url, {method:'POST', body:fd});
  if (!s3.ok) throw new ApiError({error:'The upload did not go through. Try again.'}, s3.status);
  onPhase('uploaded');
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

function washLut(room) {
  const n = room.white + room.ambient, lut = new Uint8ClampedArray(256);
  for (let c = 0; c < 256; c++) lut[c] = toSrgb((room.black + (room.white - room.black) * toLin(c) + room.ambient) / n);
  return lut;
}

function SlideCanvas({src, width, ratio = 16 / 9, room, washout, filter, highlight, pins, onPin, heads, captions, pip, led}) {
  const canvas = useRef(null);
  const H = width / ratio;
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
    // Without CORS headers the canvas cannot be read; show the plain image rather than nothing.
    img.onerror = () => { if (!img.crossOrigin) return; img.crossOrigin = null; washout = false; img.src = src; };
    img.src = src;
  }, [src, washout, room && room.white, room && room.ambient]);
  const dz = heads && room ? room.dead_zone : 0;
  return html`<div className="slide" style=${{width, height:H}}>
    <canvas ref=${canvas} style=${{width:'100%', height:'100%', display:'block', filter}}></canvas>
    ${led && html`<div className="ledgrid" aria-hidden="true"></div>`}
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
    <div className="line"><span>Hidden by heads</span></div>
    <svg width=${width} height=${hz} aria-hidden="true">${rows.map((r, ri) => Array.from({length:n + 1}, (_, i) => {
      const cx = (i + r.off) * width / n;
      return html`<g key=${ri + '-' + i} opacity=${r.op}><ellipse cx=${cx} cy=${r.cy} rx=${r.r * .82} ry=${r.r} fill="#1d2330"/><ellipse cx=${cx} cy=${r.cy + r.r * 1.95} rx=${r.r * 2.2} ry=${r.r * 1.25} fill="#1d2330"/></g>`;
    }))}</svg>
  </div>`;
}

const MODES = {
  laptop:{label:'Your laptop', cap:() => 'Your slide as it looks on your own screen.'},
  room:{label:'In the room', washout:true, heads:true, cap:r => `Projected in this room.${r && r.dead_zone ? ' Heads block what is below the amber line.' : ''}`},
  stream:{label:'On a call', call:true, cap:() => 'Shared on Zoom or Teams: your slide in a small window next to everyone\'s faces.'},
};

/* ---------- screens ---------- */
function Pick({items, value, onChange, label}) {
  const key = k => e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(k); } };
  return html`<div className="profiles" role="radiogroup" aria-label=${label}>${Object.entries(items).map(([k, it]) => html`<div key=${k} role="radio" aria-checked=${value === k} tabIndex=${0}
      className=${'profile' + (value === k ? ' on' : '')} onClick=${() => onChange(k)} onKeyDown=${key(k)}>
      ${it.icon && html`<${Icon} name=${it.icon}/>`}<b>${it.label}</b>${it.sub && html`<span>${it.sub}</span>`}</div>`)}</div>`;
}

/* ---------- progress while a check runs ---------- */
const STEPS = [
  {title:'Uploading your deck', joke:'Carrying it to the venue. Carefully.'},
  {title:'Rendering every slide', joke:'Warming up the projector. It is older than it looks.'},
  {title:'Measuring every letter', joke:'Rulers out. Yes, all of them.'},
  {title:'Simulating the room light', joke:'Dimming the house lights. Someone always leaves one on.'},
  {title:'Seating the audience', joke:'Row 18 has asked for a bigger font.'},
  {title:'Working out what matters', joke:'Footnotes are being judged. Quietly.'},
  {title:'Writing the report', joke:'Wording the bad news kindly.'},
];
const STEP_SECONDS = 6;

function CheckProgress({uploaded, rescoring, cached}) {
  const [t0] = useState(() => Date.now());
  const [now, setNow] = useState(Date.now());
  const [upAt, setUpAt] = useState(null);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(id); }, []);
  useEffect(() => { if (uploaded && !upAt) setUpAt(Date.now()); }, [uploaded]);
  const secs = (now - t0) / 1000;
  if (cached) return html`<div className="progress" role="status" aria-live="polite">
    <div className="pg-head"><b>Seen this one before</b><span className="mono">00:00</span></div>
    <div className="pg-bar"><i style=${{width:'100%'}}></i></div>
    <ol className="pg-steps">${STEPS.map((s, i) => html`<li key=${i} className="done"><span className="pg-mark">✓</span><div><div className="pg-title">${s.title}</div></div></li>`)}</ol>
    <p className="note">Same deck as last time, so we pulled up your notes. No rehearsal needed.</p>
  </div>`;
  if (rescoring) return html`<div className="progress"><div className="pg-bar"><i style=${{width:'70%'}}></i></div><p className="note">Rearranging the chairs for the new room.</p></div>`;
  const since = upAt ? (now - upAt) / 1000 : 0;
  const cur = !upAt ? 0 : Math.min(STEPS.length - 1, 1 + Math.floor(since / STEP_SECONDS));
  const pct = Math.min(96, 100 * (1 - Math.exp(-secs / 18)));
  const mmss = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
  return html`<div className="progress" role="status" aria-live="polite">
    <div className="pg-head"><b>Rehearsing your talk</b><span className="mono">${mmss}</span></div>
    <div className="pg-bar"><i style=${{width:pct + '%'}}></i></div>
    <ol className="pg-steps">${STEPS.map((s, i) => html`<li key=${i} className=${i < cur ? 'done' : i === cur ? 'now' : 'todo'}>
      <span className="pg-mark">${i < cur ? '✓' : ''}</span>
      <div><div className="pg-title">${s.title}</div>${i === cur && html`<div className="pg-joke">${s.joke}</div>`}</div>
    </li>`)}</ol>
  </div>`;
}

function Notice({note, size = 160}) {
  return html`<div className="notice" role="status">
    <${Icon} name="quota-nap" size=${size}/>
    <div><h2>${note.title}</h2><p className="note">${note.message}</p></div>
  </div>`;
}

function SetupStep({venue, setVenue, onRun, busy, error, notice, fileName, uploaded, rescoring, cached}) {
  const set = k => v => setVenue({...venue, [k]:v});
  const inRoom = venue.where !== 'online';
  return html`<div className="intake">
    <h1>Tell us about the talk</h1>
    ${fileName && html`<p className="note">Checking ${fileName}</p>`}
    <div className="q"><h2>Where will people watch?</h2><${Pick} label="Where will people watch?" items=${WHERE} value=${venue.where} onChange=${set('where')}/></div>
    ${inRoom && html`<div className="q"><h2>How big is the room?</h2><${Pick} label="How big is the room?" items=${ROOMS} value=${venue.room} onChange=${set('room')}/></div>`}
    <div className="q"><h2>How old is the oldest person likely to be there?</h2>
      <${Pick} label="Oldest person in the audience" items=${AGES} value=${venue.oldest} onChange=${set('oldest')}/>
      <span className="note">${venue.oldest === 'u40' ? 'Younger eyes. Standard text sizes work.' : 'Older eyes need bigger text and stronger colors. We will plan for them.'}</span>
    </div>
    ${inRoom && html`<${Collapse} ghost items=${[{key:'a', label:'Fine tune the room (optional)', children:html`<div className="q"><h2>Room light</h2>
      <${Radio.Group} optionType="button" value=${venue.light} onChange=${e => set('light')(e.target.value)} options=${Object.entries(LIGHTS).map(([value, label]) => ({value, label}))}/></div>`}]}/>`}
    ${notice && !busy && html`<${Notice} note=${notice} size=${96}/>`}
    ${error && html`<${Alert} type="error" showIcon message=${error}/>`}
    ${busy ? html`<${CheckProgress} uploaded=${uploaded} rescoring=${rescoring} cached=${cached}/>`
      : html`<div className="actions"><${Button} type="primary" size="large" onClick=${onRun}>See results<//></div>`}
  </div>`;
}

function QuotaNote({quota}) {
  return html`<div className="hero quota"><div>
    <${Icon} name="quota-nap" size=${240} className="icon nap"/>
    <h1>${quota.title}</h1>
    <p className="lead">${quota.message}</p>
  </div></div>`;
}

function UploadStep({onFile, onSample, samples}) {
  return html`<div className="hero">
    <div className="upload">
      <h1>Check your slides before you present</h1>
      <p className="lead">See your deck the way the back row, older guests and online viewers will, and find what they would miss.</p>
      <${Upload.Dragger} accept=".pptx,.pdf" showUploadList=${false} beforeUpload=${f => { onFile(f); return false; }}>
        <${Icon} name="deck" size=${112} className="icon deckart"/>
        <p style=${{fontSize:15, fontWeight:500, margin:'4px 0 4px'}}>Drop a PowerPoint or PDF</p>
        <p className="note" style=${{marginBottom:16}}>or click to choose a file, up to 20 MB and 40 slides</p>
      <//>
      <div style=${{marginTop:16, display:'flex', gap:8, flexWrap:'wrap', alignItems:'center'}}>
        <span className="note">Or try a sample:</span>
        ${samples.map(s => html`<${Button} key=${s} onClick=${() => onSample(s)}>${s.replace('.pptx', '')}<//>`)}
      </div>
      <p className="note" style=${{marginTop:20}}>Your slides are deleted after 24 hours. Nothing is kept or shared.</p>
    </div>
  </div>`;
}

function ResultsStep({deck, setDeck, venue, onChangeRoom}) {
  const rep = deck.report, room = rep.room;
  const [cur, setCur] = useState(0);
  const [mode, setMode] = useState(venue.where === 'online' ? 'stream' : 'room');
  const [backRow, setBackRow] = useState(false);
  const [hl, setHl] = useState(null);
  const [stageRef, stageW] = useWidth();
  useEffect(() => { setMode(venue.where === 'online' ? 'stream' : 'room'); setHl(null); }, [venue.where]);

  const imgUrl = x => x.image_url || `/api/decks/${deck.id}/${x.image}`;
  const s = rep.slides[cur], img = imgUrl(s);
  // Slide shape from the image itself: decks can be 16:9, 4:3, A4 and others.
  const [ratio, setRatio] = useState(16 / 9);
  useEffect(() => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => i.naturalHeight && setRatio(i.naturalWidth / i.naturalHeight); i.src = img; }, [img]);
  const findLine = text => s.lines.find(l => l.text === text);
  const pins = s.findings.map((f, i) => { const l = f.lines.length && findLine(f.lines[0]); return l ? {n:i + 1, x:l.left, y:l.top, impact:f.impact, key:i, on:hl === i} : null; }).filter(Boolean);
  const boxes = hl == null ? [] : (s.findings[hl] ? s.findings[hl].lines.map(findLine).filter(Boolean) : []);

  const VIEWS = venue.where === 'online' ? ['laptop', 'stream'] : venue.where === 'both' ? ['laptop', 'room', 'stream'] : ['laptop', 'room'];
  const [older, setOlder] = useState(false);
  const [cvd, setCvd] = useState(false);
  // LED walls: brighter, punchier, dark grays sink to black, bright text glows. On by default for the stage room.
  const [led, setLed] = useState(venue.where !== 'online' && venue.room === 'huge');
  useEffect(() => { setLed(venue.where !== 'online' && venue.room === 'huge'); }, [venue.where, venue.room]);
  const m = MODES[VIEWS.includes(mode) ? mode : VIEWS[1]];
  // Older eyes and color blindness layer on top of whichever view is chosen.
  const ledOn = led && venue.where !== 'online';
  const back = backRow && !!room && !!m.washout;
  const seat = room ? rowFt(room.rows) : 10;
  const lens = [ledOn && 'url(#f-led)', back && 'blur(.6px)', older && 'url(#f-old) blur(.5px)', cvd && 'url(#f-deut)'].filter(Boolean).join(' ') || undefined;
  const lensCap = [back && 'Seen from the back row.', ledOn && 'On an LED wall.', older && 'Through older eyes.', cvd && 'Through color blind eyes.'].filter(Boolean).join(' ');
  const narrow = stageW < 560;
  const inner = Math.max(160, narrow ? stageW : stageW - 48);
  const faceW = Math.round(Math.min(110, Math.max(36, inner * 0.14)));
  let w = inner;
  // Back row: shrink by distance, relative to the room view (about row 3).
  if (back) w = Math.max(140, Math.min(inner, inner * rowFt(3) / seat));
  if (m.call) w = Math.max(120, narrow ? inner - faceW - 28 : Math.min(inner * 0.66, 640));

  const map = rep.seat_map;
  const n = rep.slides.length, withIssues = rep.slides.filter(x => x.findings.some(f => f.impact !== 'minor')).length;
  const headline = withIssues === 0 ? (map ? 'Every slide is ready for this room.' : 'Every slide is ready for online viewers.')
    : `${withIssues} of ${n} slides need fixes.`;
  const deckCats = Object.fromEntries(Object.keys(CATS).map(k => [k, Math.round(rep.slides.reduce((a, x) => a + x.categories[k], 0) / n)]));
  const b = band(rep.score);

  return html`<div className="review">
    <header className="rhead">
      <div className="rtitle">
        <h1>${headline}</h1>
        <p className="context">${rep.deck}.<a role="button" tabIndex=${0} onClick=${onChangeRoom} onKeyDown=${e => e.key === 'Enter' && onChangeRoom()}>Change the room</a></p>
        <div className="venue">
          <span className="chip"><${Icon} name=${WHERE[venue.where].icon} size=${40}/>${WHERE[venue.where].label}</span>
          ${venue.where !== 'online' && html`<span className="chip"><${Icon} name=${ROOMS[venue.room].icon} size=${40}/>${ROOMS[venue.room].label}</span>`}
          <span className="chip"><${Icon} name=${AGES[venue.oldest].icon} size=${40}/>Oldest ${AGES[venue.oldest].label.toLowerCase()}</span>
        </div>
      </div>
      <div className="rscore">
        <div className="score"><b style=${{color:b.color}}>${rep.score}</b><span>score, ${b.label.toLowerCase()}</span></div>
        <div className="cats-strip">${Object.entries(CATS).map(([k, l]) => html`<div key=${k} className="cat"><${Icon} name=${'cat-' + k} size=${48}/><div><b style=${{color:band(deckCats[k]).color}}>${deckCats[k]}</b><span>${l}</span></div></div>`)}</div>
      </div>
    </header>


    <div className="workspace">
      <div className="stagecol">
        <div className="stagebar">
          <div className="viewpick"><${Segmented} value=${VIEWS.includes(mode) ? mode : VIEWS[1]} onChange=${setMode} options=${VIEWS.map(value => ({value, label:MODES[value].label}))}/></div>
          <div className="lenses">${room && m.washout && html`<label className="lens"><${Switch} size="small" checked=${backRow} onChange=${setBackRow}/>Back row</label>`}${venue.where !== 'online' && html`<label className="lens"><${Switch} size="small" checked=${led} onChange=${setLed}/>LED wall</label>`}<label className="lens"><${Switch} size="small" checked=${older} onChange=${setOlder}/>Older eyes</label>
          <label className="lens"><${Switch} size="small" checked=${cvd} onChange=${setCvd}/>Color blind</label></div>
        </div>
        <div className="stagebox" ref=${stageRef}>
          ${m.call ? html`<div className="call">
              <${SlideCanvas} src=${img} width=${w} ratio=${ratio} room=${room} washout=${false} filter=${lens} highlight=${boxes} pins=${pins} onPin=${p => setHl(p.key)}/>
              <div className="faces" style=${{height:w / ratio, width:faceW}}>${[0, 1, 2, 3].map(i => html`<div key=${i} className="face"><i></i></div>`)}</div>
            </div>`
          : html`<${SlideCanvas} src=${img} width=${w} ratio=${ratio} room=${room} washout=${m.washout} filter=${lens} heads=${m.heads} led=${ledOn && w > 360}
            captions=${false} highlight=${boxes} pins=${pins} onPin=${p => setHl(p.key)}/>`}
        </div>
        <div className="cap">${m.cap(room)}${lensCap ? ' ' + lensCap : ''}</div>
        <div className="film" role="list">
          ${rep.slides.map((x, i) => html`<div key=${x.image} role="listitem" tabIndex=${0} className=${'thumb' + (i === cur ? ' on' : '')}
              onClick=${() => { setCur(i); setHl(null); }} onKeyDown=${e => e.key === 'Enter' && (setCur(i), setHl(null))}>
            <img src=${imgUrl(x)} crossOrigin="anonymous" width="132" height=${Math.round(132 / ratio)} alt=${'Slide ' + (i + 1)} loading="lazy"/>
            <div className="meta"><span>${i + 1}</span><b style=${{color:band(x.score).color}}>${x.score}</b></div>
          </div>`)}
        </div>
      </div>

      <aside className="notes">
        <div className="panel-head"><h2>Slide ${cur + 1}</h2><span className="mono" style=${{color:band(s.score).color, fontWeight:600}}>${s.score}</span></div>
        ${s.findings.length === 0 && html`<div className="allclear"><${Icon} name="all-clear" size=${140}/>Everyone will see this slide clearly.</div>`}
        <ol className="flist">
          ${s.findings.map((f, i) => html`<li key=${i} tabIndex=${0} className=${'finding ' + f.impact + (hl === i ? ' sel' : '')}
              onClick=${() => setHl(hl === i ? null : i)} onKeyDown=${e => e.key === 'Enter' && setHl(hl === i ? null : i)}>
            <span className=${'num ' + f.impact}>${i + 1}</span>
            <div className="fbody">
              <div className="t">${f.title}</div>
              <p>${f.detail}</p>
              ${f.lines.length > 0 && html`<p className="quote">${f.lines.slice(0, 3).map(t => t.length > 48 ? t.slice(0, 47) + '…' : t).join(' / ')}${f.lines.length > 3 ? ` and ${f.lines.length - 3} more` : ''}</p>`}
              <div className="row"><span className="who">Affects ${f.who.charAt(0).toLowerCase() + f.who.slice(1)}</span></div>
            </div>
          </li>`)}
        </ol>
      </aside>
    </div>
  </div>`;
}

function Main() {
  const [step, setStep] = useState(0);
  const [venue, setVenue] = useState({where:'room', room:'medium', oldest:'40s', light:'dimmed'});
  const [pending, setPending] = useState(null);      // {file} or {sample}
  const [deck, setDeck] = useState(null);            // {id, report}
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [samples, setSamples] = useState([]);
  const [quota, setQuota] = useState(null);           // {title, message} once the budget is used up
  const [uploaded, setUploaded] = useState(false);
  const [cached, setCached] = useState(false);        // true when the same file was checked before
  const [notice, setNotice] = useState(null);         // {title, message} when this deck is being checked right now
  useEffect(() => {
    if (CLOUD) { setSamples(['problems.pptx']); api('/api/status').then(s => setQuota(s.quota)).catch(() => {}); }
    else api('/api/options').then(o => setSamples(o.samples)).catch(() => {});
  }, []);

  const run = async () => {
    setBusy(true); setError(null); setNotice(null); setCached(false); setUploaded(!CLOUD);
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
        res = await cloudCheck(file, venue, (phase, info) => { setUploaded(true); if (info && info.cached) setCached(true); });
        res.report.deck = pending.sample ? `${pending.sample} (sample)` : res.report.deck;
        track('check_done', {score: res.report.score, slides: res.report.slides.length, cached: !!res.cached, seconds: Math.round((Date.now() - t0) / 1000)});
      } else if (pending.sample) res = await jsonPost(`/api/samples/${encodeURIComponent(pending.sample)}`, venue);
      else {
        const fd = new FormData(); fd.append('file', pending.file);
        Object.entries(venue).forEach(([k, v]) => fd.append(k, v));
        res = await api('/api/decks', {method:'POST', body:fd});
      }
      setDeck(res); setPending(null); setStep(2);
    } catch (e) {
      if (e.status === 409 && e.body && e.body.title) { setNotice(e.body); track('check_busy'); }
      else if (e.body && e.body.title) { setQuota(e.body); setStep(0); track('quota_hit'); }
      else { setError(e.message); track('check_error', {status: e.status || 0}); }
    }
    finally { setBusy(false); }
  };
  const tabs = ['Slides', 'Room', 'Results'];
  const canGo = i => i === 0 || (i === 1 && (pending || deck)) || (i === 2 && deck);
  return html`<div className="wrap">
    <div className="top">
      <div className="brand"><img className="lockup" src="icons/logo-lockup.png" alt="SlideReady" height="40"/></div>
      <nav className="tabs">${tabs.map((l, i) => html`<button key=${l} className=${step === i ? 'on' : ''} disabled=${!canGo(i)} onClick=${() => canGo(i) && setStep(i)}>${l}</button>`)}</nav>
    </div>
    ${step === 0 && quota && html`<${QuotaNote} quota=${quota}/>`}
    ${step === 0 && !quota && html`<${UploadStep} samples=${samples} onFile=${f => { setPending({file:f}); setStep(1); }} onSample=${s => { setPending({sample:s}); setStep(1); }}/>`}
    ${step === 1 && html`<${SetupStep} venue=${venue} setVenue=${setVenue} onRun=${run} busy=${busy} error=${error} notice=${notice}
        uploaded=${uploaded} cached=${cached} rescoring=${!!(deck && !pending)}
        fileName=${pending ? (pending.file ? pending.file.name : pending.sample) : deck && deck.report.deck}/>`}
    ${step === 2 && deck && html`<${ResultsStep} deck=${deck} setDeck=${setDeck} venue=${venue} onChangeRoom=${() => setStep(1)}/>`}
    <footer className="foot">Made by <a href="https://vallabh.me">Vallabh</a></footer>
  </div>`;
}

const theme = {token:{colorPrimary:'#3563c9', colorText:'#1d2740', colorTextSecondary:'#56617a', colorBorder:'#dce3ef', fontFamily:'"Nunito", ui-rounded, system-ui, sans-serif', fontSize:15, borderRadius:10, colorBgLayout:'#eef2f9'}};
ReactDOM.createRoot(document.getElementById('root')).render(html`<${ConfigProvider} theme=${theme}><${AntApp}><${Main}/><//><//>`);
