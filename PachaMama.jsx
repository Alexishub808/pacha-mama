import { useState, useRef, useEffect } from "react";

async function askClaude(plantName) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: "You are a botanical expert. Reply ONLY with a valid JSON object. No markdown, no backticks, no explanation text whatsoever.",
      messages: [{
        role: "user",
        content: `Plant datasheet for: "${plantName}"

Return ONLY this JSON, all text values in German:
{"found":true,"latinName":"correct latin name","commonName":"german name","typo":false,"suggestions":[],"badges":[{"label":"Winterhart","type":"blue"}],"overview":"2 sentences about origin and character.","facts":{"Familie":"...","Wuchshoehe":"...","Lebensdauer":"...","Bluetezeit":"...","Winterhaerte":"...","Giftigkeit":"...","Verwendung":"..."},"neighbors":{"good":["plant a","plant b"],"bad":["plant x"]},"planting":{"boden":"...","standort":"...","pflanzzeit":"...","duengung":"...","tip":"one practical tip"},"care":{"giessen":"...","schnitt":"...","schaedlinge":"...","winter":"...","tip":"one practical tip"},"wikiSearch":"english wikipedia search term for plant image","commonsFile":"file name of a photo of this plant on Wikimedia Commons"}

Rules:
- Typo but recognizable (e.g. lavandulla): found=true, typo=true, correct latinName
- Unknown: found=false, suggestions=[{"latin":"...","german":"..."}] up to 5
- Badge types: green, red, amber, blue, gray
- commonsFile: the bare file name only, no "File:" prefix and no URL, e.g.
  "Lavandula angustifolia - harilik lavendel.jpg". A photograph, not a drawing
  or a map. Empty string if you are not confident the file exists.`
      }]
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "API error");
  const text = data.content.map(b => b.text || "").join("").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON in response");
  let s = text.slice(start, end + 1);
  try { return JSON.parse(s); }
  catch { return JSON.parse(s.replace(/,(\s*[}\]])/g, "$1")); }
}

// ── Plant image lookup ──────────────────────────────────────────────────────
// Only sources with an explicit free licence. Google Images is not one: it
// indexes third-party pictures it has no right to sublicence, and its only
// official API needs a paid key that a browser cannot hold safely.
// Every source below is keyless and CORS-enabled (origin=* on the MediaWiki
// endpoints is what makes them answer a cross-origin browser request).

const PHOTO_EXT = /\.(jpe?g|png)$/i;

// 1. The lead image of the Wikipedia article.
async function wikipediaImage(term) {
  for (const q of [
    `action=query&titles=${encodeURIComponent(term)}`,
    `action=query&generator=search&gsrlimit=3&gsrsearch=${encodeURIComponent(term)}`,
  ]) {
    const r = await fetch(`https://en.wikipedia.org/w/api.php?format=json&origin=*&redirects=1&prop=pageimages&piprop=thumbnail&pithumbsize=500&${q}`);
    const d = await r.json();
    for (const p of Object.values(d?.query?.pages || {})) {
      if (p?.thumbnail?.source) return { src: p.thumbnail.source, credit: "© Wikipedia" };
    }
  }
  return null;
}

// 2. Wikimedia Commons — has photos for species whose article lacks one.
//    Namespace 6 is the file namespace; drop drawings, maps and diagrams.
async function commonsImage(term) {
  const r = await fetch(`https://commons.wikimedia.org/w/api.php?format=json&origin=*&action=query&generator=search&gsrnamespace=6&gsrlimit=8&gsrsearch=${encodeURIComponent(term)}&prop=imageinfo&iiprop=url&iiurlwidth=500`);
  const d = await r.json();
  for (const p of Object.values(d?.query?.pages || {})) {
    const info = p?.imageinfo?.[0];
    if (info?.thumburl && PHOTO_EXT.test(info.url || "")) {
      return { src: info.thumburl, credit: "© Wikimedia Commons" };
    }
  }
  return null;
}

// 3. iNaturalist — observation photos, CC-licensed, photographer named in
//    the attribution string the API returns.
async function inaturalistImage(term) {
  const r = await fetch(`https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(term)}&per_page=3`);
  const d = await r.json();
  for (const t of d?.results || []) {
    const photo = t?.default_photo;
    if (photo?.medium_url || photo?.url) {
      const credit = (photo.attribution || "iNaturalist").replace(/\s*\(c\)\s*/i, "© ");
      return { src: photo.medium_url || photo.url, credit: credit.slice(0, 70) };
    }
  }
  return null;
}

// 0. No lookup at all: Special:FilePath redirects a bare Commons file name to
//    the actual image, so a file name from the datasheet response is enough.
//    This is the only path that survives a host whose network policy allows
//    displaying images but not querying other servers — the case inside the
//    Claude artifact sandbox, where every fetch above is refused.
function commonsFileImage(file) {
  if (!file) return null;
  const clean = String(file).replace(/^file:/i, "").trim().replace(/ /g, "_");
  if (!PHOTO_EXT.test(clean)) return null;
  return {
    src: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(clean)}?width=500`,
    credit: "© Wikimedia Commons",
  };
}

// Tries the direct file name first, then the lookup sources with every
// candidate name. A failing source must never block the next one.
// Returns {src, credit} on success, or {src:null, reason} so the caller can
// tell "nothing found" apart from "every request was refused".
async function getPlantImage(term, latin, commonsFile) {
  const direct = commonsFileImage(commonsFile);
  if (direct) return direct;

  const candidates = [...new Set([term, latin].filter(Boolean))];
  let refused = 0, attempts = 0;
  for (const source of [wikipediaImage, commonsImage, inaturalistImage]) {
    for (const c of candidates) {
      attempts++;
      try {
        const hit = await source(c);
        if (hit?.src) return hit;
      } catch { refused++; }
    }
  }
  return { src: null, reason: attempts > 0 && refused === attempts ? "blocked" : "none" };
}

function buildMarkdown(d) {
  const date = new Date().toLocaleDateString("de-DE", { year: "numeric", month: "long", day: "numeric" });
  const badges = (d.badges || []).map(b => `\`${b.label}\``).join(" ");
  const facts = Object.entries(d.facts || {}).filter(([, v]) => v).map(([k, v]) => `| ${k} | ${v} |`).join("\n");
  const good = (d.neighbors?.good || []).map(p => `- ✓ ${p}`).join("\n") || "–";
  const bad  = (d.neighbors?.bad  || []).map(p => `- ✗ ${p}`).join("\n") || "–";
  const pl = d.planting || {}, ca = d.care || {};
  return `# *${d.latinName}*\n### ${d.commonName || ""}\n\n${badges}\n\n> ${d.overview || ""}\n\n---\n\n## 📋 Botanisches Datenblatt\n\n| Eigenschaft | Wert |\n|-------------|------|\n${facts}\n\n---\n\n## 🌿 Nachbarschaft\n\n**Gute Nachbarn:**\n${good}\n\n**Schlechte Nachbarn:**\n${bad}\n\n---\n\n## 🌱 Pflanzen\n\n| | |\n|---|---|\n| **Boden** | ${pl.boden || "–"} |\n| **Standort** | ${pl.standort || "–"} |\n| **Pflanzzeit** | ${pl.pflanzzeit || "–"} |\n| **Düngung** | ${pl.duengung || "–"} |\n\n> 💡 ${pl.tip || "–"}\n\n---\n\n## 💧 Pflege\n\n| | |\n|---|---|\n| **Gießen** | ${ca.giessen || "–"} |\n| **Schnitt** | ${ca.schnitt || "–"} |\n| **Schädlinge** | ${ca.schaedlinge || "–"} |\n| **Überwinterung** | ${ca.winter || "–"} |\n\n> 💡 ${ca.tip || "–"}\n\n---\n\n*Erstellt mit Pacha Mama · ${date}*\n`;
}

const BADGE_COLORS = {
  green: { bg: "#d4edcc", fg: "#1a5010" },
  red:   { bg: "#fad4cc", fg: "#7a1a0a" },
  amber: { bg: "#faeacc", fg: "#7a4a0a" },
  blue:  { bg: "#ccdcf0", fg: "#0a2a6a" },
  gray:  { bg: "#e0dcd8", fg: "#3a3028" },
};
const C = { moss:"#3a5c2a", sage:"#6e9060", rust:"#7a3a18", cream:"#f8f3ea", parchment:"#ede4ce", border:"#ddd5bc", earth:"#1e1408" };
const EXAMPLES = ["Lavandula angustifolia","Rosa canina","Hedera helix","Atropa belladonna","Fagus sylvatica"];

function Badge({ label, type }) {
  const col = BADGE_COLORS[type] || BADGE_COLORS.gray;
  return <span style={{ background:col.bg, color:col.fg, fontSize:10, fontWeight:700, letterSpacing:"0.1em", textTransform:"uppercase", padding:"3px 8px", borderRadius:3, fontFamily:"system-ui,sans-serif" }}>{label}</span>;
}

function Card({ label, value }) {
  return (
    <div style={{ background:C.cream, border:`1px solid ${C.border}`, borderRadius:6, padding:"8px 11px" }}>
      <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.12em", textTransform:"uppercase", color:C.sage, marginBottom:3, fontFamily:"system-ui,sans-serif" }}>{label}</div>
      <div style={{ fontSize:13, fontWeight:500, color:C.earth, lineHeight:1.45, fontFamily:"system-ui,sans-serif" }}>{value}</div>
    </div>
  );
}

function Grid({ items }) {
  const entries = Object.entries(items || {}).filter(([, v]) => v);
  if (!entries.length) return null;
  return (
    <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(148px,1fr))", gap:8, marginBottom:12 }}>
      {entries.map(([k, v]) => <Card key={k} label={k} value={v} />)}
    </div>
  );
}

function Tip({ text }) {
  return (
    <div style={{ background:"#eaf5e4", borderLeft:"3px solid #8ab878", borderRadius:"0 6px 6px 0", padding:"10px 13px", marginTop:10, fontSize:13, fontStyle:"italic", color:"#2a5c1a", lineHeight:1.65, fontFamily:"system-ui,sans-serif" }}>
      <strong style={{ fontStyle:"normal", color:"#3a6a28" }}>Pacha Mama empfiehlt: </strong>{text}
    </div>
  );
}

// Captions double as a diagnostic: they say which of the three failure modes
// occurred, so a blocked host is distinguishable from a missing photo.
const IMG_CAPTIONS = {
  none: "kein Bild gefunden",
  blocked: "Bildquelle nicht erreichbar",
  broken: "Bild-Adresse blockiert",
};

function PlantImg({ term, latin, commonsFile }) {
  const [img, setImg] = useState(null);
  const [state, setState] = useState("loading"); // loading | ok | none | blocked | broken
  useEffect(() => {
    let alive = true;
    setImg(null);
    setState("loading");
    getPlantImage(term, latin, commonsFile).then(hit => {
      if (!alive) return;
      setImg(hit?.src ? hit : null);
      setState(hit?.src ? "ok" : hit?.reason || "none");
    });
    return () => { alive = false; };
  }, [term, latin, commonsFile]);
  const base = { width:"100%", aspectRatio:"3/4", borderRadius:6, border:`1px solid ${C.border}` };
  const caption = state === "ok" ? img.credit : IMG_CAPTIONS[state] || "";
  return (
    <div style={{ width:130, flexShrink:0 }}>
      {img
        ? <img src={img.src} alt={latin || ""} onError={() => { setImg(null); setState("broken"); }} style={{ ...base, objectFit:"cover", display:"block" }} />
        : <div style={{ ...base, background:C.parchment, display:"flex", alignItems:"center", justifyContent:"center", fontSize:34, opacity: state==="loading" ? 0.45 : 1 }}>🌿</div>
      }
      <div title={caption} style={{ fontSize:10, color:"#9a8a72", textAlign:"center", marginTop:3, fontStyle:"italic", fontFamily:"system-ui,sans-serif", minHeight:13, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{caption}</div>
    </div>
  );
}

// ── Markdown Modal ──────────────────────────────────────────────────────────

function MdModal({ text, onClose }) {
  // "idle" | "copied" | "manual"  — "manual" = Zwischenablage vom Browser
  // blockiert, Text ist aber markiert und wartet auf Strg+C.
  const [state, setState] = useState("idle");
  const taRef = useRef(null);

  // Beim Öffnen den kompletten Text markieren, damit ein Tastendruck reicht.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    ta.select();
  }, []);

  function selectAll() {
    const ta = taRef.current;
    if (!ta) return null;
    ta.focus();
    ta.select();
    try { ta.setSelectionRange(0, ta.value.length); } catch { /* ältere Browser */ }
    return ta;
  }

  async function copy() {
    // 1. execCommand auf dem sichtbaren Textfeld. Funktioniert auch im
    //    Sandbox-iframe, in dem navigator.clipboard blockiert ist.
    const ta = selectAll();
    if (ta) {
      try {
        if (document.execCommand("copy")) {
          flash("copied");
          return;
        }
      } catch { /* weiter zu Versuch 2 */ }
    }
    // 2. Moderne Clipboard-API als Zweitversuch.
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        flash("copied");
        return;
      }
    } catch { /* weiter zu Versuch 3 */ }
    // 3. Beides blockiert: Text bleibt markiert, Nutzer drückt Strg+C.
    setState("manual");
  }

  function flash(next) {
    setState(next);
    setTimeout(() => setState("idle"), 2000);
  }

  const btnLabel = state === "copied" ? "✓ Kopiert!"
                 : state === "manual" ? "Strg+C drücken"
                 : "📋 Kopieren";

  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background:"#fff", borderRadius:10, width:"100%", maxWidth:640, maxHeight:"80vh", display:"flex", flexDirection:"column", overflow:"hidden", boxShadow:"0 8px 40px rgba(0,0,0,0.25)" }}>
        <div style={{ display:"flex", alignItems:"center", padding:"14px 18px", borderBottom:`1px solid ${C.border}` }}>
          <div style={{ flex:1, fontWeight:700, fontSize:14, color:C.earth, fontFamily:"system-ui,sans-serif" }}>Markdown Export</div>
          <button onClick={copy} style={{ border:`1px solid ${C.border}`, background: state==="copied"?"#eaf5e4":"#fff", color: state==="copied"?"#2a5c1a":C.sage, borderRadius:6, padding:"5px 14px", fontSize:12, fontFamily:"system-ui,sans-serif", fontWeight:700, cursor:"pointer", marginRight:8, whiteSpace:"nowrap" }}>
            {btnLabel}
          </button>
          <button onClick={onClose} style={{ border:"none", background:"none", fontSize:18, cursor:"pointer", color:"#aaa", lineHeight:1, padding:"0 4px" }}>✕</button>
        </div>
        <div style={{ flex:1, minHeight:0, padding:"14px 18px", display:"flex" }}>
          <textarea
            ref={taRef}
            readOnly
            spellCheck={false}
            value={text}
            onFocus={e => e.target.select()}
            style={{ flex:1, width:"100%", resize:"none", border:`1px solid ${C.border}`, borderRadius:6, padding:"10px 12px", fontFamily:"monospace", fontSize:12, lineHeight:1.6, color:"#2a2a2a", background:"#fbfaf7", outline:"none" }}
          />
        </div>
        <div style={{ padding:"10px 18px", borderTop:`1px solid ${C.border}`, fontSize:11, color:"#8a7a60", fontFamily:"system-ui,sans-serif", fontStyle:"italic" }}>
          Text ist bereits markiert — Strg+C, dann in Joplin als neue Notiz einfügen.
        </div>
      </div>
    </div>
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

export default function PachaMama() {
  const [query,   setQuery]   = useState("");
  const [status,  setStatus]  = useState("idle");
  const [result,  setResult]  = useState(null);
  const [error,   setError]   = useState("");
  const [tab,     setTab]     = useState(0);
  const [showMd,  setShowMd]  = useState(false);

  async function search(name) {
    const q = (name ?? query).trim();
    if (!q) return;
    setQuery(q);
    setStatus("loading");
    setResult(null);
    setTab(0);
    setShowMd(false);
    try {
      const data = await askClaude(q);
      setResult(data);
      setStatus("done");
    } catch (e) {
      setError(e.message);
      setStatus("error");
    }
  }

  const pl = result?.planting || {};
  const ca = result?.care || {};
  const plantItems = { "Boden":pl.boden, "Standort":pl.standort, "Pflanzzeit":pl.pflanzzeit, "Düngung":pl.duengung };
  const careItems  = { "Gießen":ca.giessen, "Schnitt":ca.schnitt, "Schädlinge":ca.schaedlinge, "Überwinterung":ca.winter };

  return (
    <div style={{ fontFamily:"Georgia,serif", background:C.cream, color:C.earth, minHeight:"100vh", paddingBottom:56 }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>

      {showMd && result && <MdModal text={buildMarkdown(result)} onClose={() => setShowMd(false)} />}

      {/* Header */}
      <div style={{ textAlign:"center", padding:"32px 20px 24px", borderBottom:`1px solid ${C.border}`, marginBottom:24 }}>
        <div style={{ fontSize:11, letterSpacing:"0.26em", textTransform:"uppercase", color:C.sage, fontFamily:"system-ui,sans-serif", marginBottom:5 }}>Botanisches Pflanzenlexikon</div>
        <h1 style={{ margin:0, fontSize:"clamp(2.6rem,7vw,4.2rem)", fontWeight:700, color:C.moss, lineHeight:1, letterSpacing:"-0.02em" }}>Pacha Mama</h1>
        <div style={{ fontStyle:"italic", fontSize:14, color:C.rust, marginTop:5 }}>Mutter Erde flüstert — wir hören zu</div>
      </div>

      <div style={{ maxWidth:800, margin:"0 auto", padding:"0 16px" }}>

        {/* Search */}
        <div style={{ display:"flex", border:`2px solid ${C.moss}`, borderRadius:6, overflow:"hidden", background:"#fff", boxShadow:"0 4px 18px rgba(30,20,8,.08)", marginBottom:10 }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === "Enter" && search()}
            placeholder="z.B. Lavandula angustifolia …"
            style={{ flex:1, border:"none", outline:"none", padding:"12px 14px", fontFamily:"Georgia,serif", fontStyle:"italic", fontSize:16, color:C.earth, background:"transparent" }}
          />
          <button onClick={() => search()} disabled={status==="loading"} style={{ border:"none", background:status==="loading"?"#aaa":C.moss, color:"#f8f3ea", padding:"0 22px", fontFamily:"system-ui,sans-serif", fontSize:11, letterSpacing:"0.14em", textTransform:"uppercase", fontWeight:700, cursor:status==="loading"?"default":"pointer" }}>
            {status === "loading" ? "…" : "Erkunden"}
          </button>
        </div>

        {/* Examples */}
        <div style={{ fontSize:12, color:"#8a7a60", marginBottom:24, fontFamily:"system-ui,sans-serif" }}>
          Beispiele:{" "}
          {EXAMPLES.map(e => <span key={e} onClick={() => search(e)} style={{ cursor:"pointer", fontStyle:"italic", color:C.moss, borderBottom:`1px dotted ${C.sage}`, margin:"0 4px" }}>{e}</span>)}
        </div>

        {/* Loading */}
        {status === "loading" && (
          <div style={{ textAlign:"center", padding:"52px 0", color:C.sage }}>
            <div style={{ width:38, height:38, border:"3px solid #ccdcc4", borderTopColor:C.moss, borderRadius:"50%", animation:"spin .8s linear infinite", margin:"0 auto 14px" }} />
            <div style={{ fontStyle:"italic", fontSize:15 }}>Pacha Mama konsultiert die Wurzeln …</div>
          </div>
        )}

        {/* Error */}
        {status === "error" && (
          <div style={{ background:"#fdf0ee", border:"1px solid #e0b0a0", borderRadius:6, padding:"13px 16px", color:"#8c2e18", fontSize:14, fontFamily:"system-ui,sans-serif" }}>⚠️ {error}</div>
        )}

        {/* Idle */}
        {status === "idle" && (
          <div style={{ textAlign:"center", padding:"52px 16px", color:"#9a8a70", fontFamily:"system-ui,sans-serif" }}>
            <div style={{ fontSize:50, opacity:0.28, marginBottom:12 }}>🌿</div>
            <div style={{ fontFamily:"Georgia,serif", fontStyle:"italic", fontSize:18, color:C.sage, marginBottom:7 }}>Pflanzenwissen aus der Erde selbst</div>
            <div style={{ fontSize:14, maxWidth:360, margin:"0 auto", lineHeight:1.7 }}>Gib einen lateinischen Pflanzennamen ein und erhalte ein umfassendes Datenblatt.</div>
          </div>
        )}

        {/* Not found */}
        {status === "done" && result && !result.found && (
          <div style={{ background:"#fdf6e8", border:"1px solid #e0d0a0", borderRadius:10, padding:"18px 20px" }}>
            <div style={{ fontWeight:700, fontSize:15, color:"#7a5010", marginBottom:4, fontFamily:"system-ui,sans-serif" }}>🌿 „{result.latinName || query}" nicht gefunden</div>
            <div style={{ fontSize:13, color:"#9a7a40", fontStyle:"italic", marginBottom:12, fontFamily:"system-ui,sans-serif" }}>Meintest du eine dieser Pflanzen?</div>
            <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
              {(result.suggestions || []).map(s => (
                <span key={s.latin} onClick={() => search(s.latin)} style={{ cursor:"pointer", background:"#fff", border:`1px solid ${C.border}`, borderRadius:20, padding:"5px 14px", fontSize:13, fontFamily:"system-ui,sans-serif" }}>
                  <em style={{ color:C.moss, fontWeight:700 }}>{s.latin}</em>
                  {s.german && <span style={{ color:"#8a7a60", marginLeft:5 }}>— {s.german}</span>}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Found */}
        {status === "done" && result && result.found && (
          <div style={{ animation:"fadeUp .4s ease both" }}>
            {result.typo && (
              <div style={{ background:"#eef4fd", border:"1px solid #b8cce8", borderRadius:6, padding:"7px 14px", fontSize:13, color:"#1a4a8c", marginBottom:10, fontFamily:"system-ui,sans-serif" }}>
                ℹ️ Tippfehler erkannt — Ergebnis für: <em style={{ fontWeight:700 }}>{result.latinName}</em>
              </div>
            )}

            {/* Hero */}
            <div style={{ display:"flex", gap:18, alignItems:"flex-start", background:"linear-gradient(135deg,#fff 55%,#ccdcc4 100%)", border:`1px solid ${C.border}`, borderRadius:10, padding:18, marginBottom:14, boxShadow:"0 2px 10px rgba(30,20,8,.05)" }}>
              <PlantImg term={result.wikiSearch} latin={result.latinName} commonsFile={result.commonsFile} />
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontStyle:"italic", fontWeight:700, fontSize:"clamp(1.3rem,3vw,1.85rem)", color:C.moss, lineHeight:1.2 }}>{result.latinName}</div>
                {result.commonName && <div style={{ fontSize:14, color:C.rust, marginTop:3, fontFamily:"system-ui,sans-serif" }}>{result.commonName}</div>}
                <div style={{ display:"flex", flexWrap:"wrap", gap:5, marginTop:9 }}>
                  {(result.badges || []).map((b, i) => <Badge key={i} {...b} />)}
                </div>
                <div style={{ fontSize:13, lineHeight:1.75, color:"#3a2c1a", marginTop:10, fontFamily:"system-ui,sans-serif" }}>{result.overview}</div>
              </div>
            </div>

            {/* Tabs + export */}
            <div style={{ display:"flex", alignItems:"center", borderBottom:`1px solid ${C.border}`, marginBottom:14 }}>
              <div style={{ display:"flex", flex:1 }}>
                {["📋 Datenblatt","🌱 Pflanzen","💧 Pflege"].map((label, i) => (
                  <button key={i} onClick={() => setTab(i)} style={{ border:"none", background:"none", cursor:"pointer", padding:"8px 14px", fontSize:13, fontFamily:"system-ui,sans-serif", fontWeight:tab===i?700:400, color:tab===i?C.moss:"#8a7a60", borderBottom:tab===i?`2px solid ${C.moss}`:"2px solid transparent", marginBottom:-1 }}>
                    {label}
                  </button>
                ))}
              </div>
              <button onClick={() => setShowMd(true)} style={{ border:`1px solid ${C.border}`, background:"#fff", color:C.sage, borderRadius:6, padding:"5px 11px", fontSize:12, fontFamily:"system-ui,sans-serif", fontWeight:600, cursor:"pointer", marginBottom:2, whiteSpace:"nowrap" }}>
                📋 .md Export
              </button>
            </div>

            {/* Tab 0 */}
            {tab === 0 && (
              <div>
                <Grid items={result.facts} />
                {result.neighbors && (
                  <>
                    <div style={{ fontSize:11, fontWeight:700, letterSpacing:"0.13em", textTransform:"uppercase", color:C.sage, margin:"14px 0 8px", fontFamily:"system-ui,sans-serif" }}>Nachbarschaft</div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                      {[["Gute Nachbarn",result.neighbors.good,"#2a5c1e","✓"],["Schlechte Nachbarn",result.neighbors.bad,"#8c2e18","✗"]].map(([title,list,col,sym]) => (
                        <div key={title} style={{ background:C.parchment, border:`1px solid ${C.border}`, borderRadius:6, padding:"10px 12px" }}>
                          <div style={{ fontSize:10, fontWeight:700, letterSpacing:"0.12em", textTransform:"uppercase", color:C.sage, marginBottom:5, fontFamily:"system-ui,sans-serif" }}>{title}</div>
                          {(list||[]).map(p => <div key={p} style={{ fontSize:13, lineHeight:1.8, fontFamily:"system-ui,sans-serif" }}><span style={{ color:col, fontWeight:700 }}>{sym} </span>{p}</div>)}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Tab 1 */}
            {tab === 1 && <div><Grid items={plantItems} />{pl.tip && <Tip text={pl.tip} />}</div>}

            {/* Tab 2 */}
            {tab === 2 && <div><Grid items={careItems} />{ca.tip && <Tip text={ca.tip} />}</div>}

            <div style={{ marginTop:24, padding:"11px 14px", background:C.parchment, borderRadius:6, fontSize:11, color:"#7a6a50", fontStyle:"italic", textAlign:"center", lineHeight:1.65, fontFamily:"system-ui,sans-serif" }}>
              Alle Angaben basieren auf öffentlich verfügbaren wissenschaftlichen Quellen. Pacha Mama ersetzt keine professionelle Beratung. Bei Giftpflanzen: Kinder und Tiere schützen.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
