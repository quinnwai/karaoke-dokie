// A one-file dashboard of the tempo data (QWW-54): the spread of every song's tempo, all songs or one era, split by
// feel label, so "slow", "mid" and "upbeat" can be read against real bpm. Read-only: it only SELECTs, and writes one
// self-contained HTML file (no server, no network; open it in a browser).
// Usage: npm run tempo:dashboard [-- --out tempo-dashboard.html]   (needs DATABASE_URL)

import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { neonQuery } from '../src/lib/server/getStore';
import { FEEL_BANDS } from '../src/lib/tempo/feel';
import { combineTempo, foldBpm, ultrastarTempo } from '../src/lib/tempo/tempo';
import { ERA_LABEL, eraOf } from '../src/lib/songs/setlistConfig';
import { ERA_IDS } from '../src/lib/contracts';

const FEEL_CODE: Record<string, number> = { slow: 0, mid: 1, upbeat: 2 };
const ERA_CODE = (y: number | null) => {
  const e = eraOf(y ?? undefined);
  return e ? ERA_IDS.indexOf(e) : -1;
};
const r1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'tempo-dashboard.html' } } });
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('Set DATABASE_URL');
  const query = neonQuery(url);

  // One row per song with a tempo reading. Year: USDB's, else the Billboard Year-End year (as the app's `year`, minus Spotify's album year, which is not stored per song).
  const rows = await query(
    `SELECT t.song_key, t.deezer_bpm, t.tracker_bpm, t.ultrastar_bpm, f.feel,
            COALESCE((SELECT MIN(u.year) FROM usdb_songs u WHERE u.song_key = t.song_key AND u.year > 0), p.chart_year) AS year
       FROM song_tempo t
       LEFT JOIN song_feel f ON f.song_key = t.song_key
       LEFT JOIN song_popularity p ON p.song_key = t.song_key
      WHERE t.deezer_bpm IS NOT NULL OR t.tracker_bpm IS NOT NULL OR t.ultrastar_bpm IS NOT NULL`,
  );

  // [combined, deezer, tracker, ultrastar, feel(-1 none), era(-1 none)], tempos folded into 70 to 180 as the app does.
  const songs = rows.map((r) => {
    const rec = { deezerBpm: (r.deezer_bpm as number | null) ?? undefined, trackerBpm: (r.tracker_bpm as number | null) ?? undefined, ultrastarBpm: (r.ultrastar_bpm as number | null) ?? undefined };
    const year = r.year === null || r.year === undefined ? null : Number(r.year);
    return [
      r1(combineTempo(rec)?.tempo ?? null),
      r1(foldBpm(rec.deezerBpm)),
      r1(foldBpm(rec.trackerBpm)),
      r1(ultrastarTempo(rec.ultrastarBpm)),
      r.feel ? (FEEL_CODE[String(r.feel)] ?? -1) : -1,
      ERA_CODE(year),
    ];
  });

  const html = PAGE.replace('__DATA__', JSON.stringify({ songs, eras: ERA_IDS.map((e) => ERA_LABEL[e]), bands: FEEL_BANDS }));
  await writeFile(values.out!, html);
  console.log(`Wrote ${values.out} (${songs.length} songs with a tempo)`);
}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tempo distribution</title>
<style>
:root{--ink:#1f2430;--mute:#6b7280;--slow:#3b82c4;--mid:#8a8f99;--up:#e0663a;--bg:#fafaf8}
body{font:15px/1.45 system-ui,sans-serif;color:var(--ink);background:var(--bg);margin:0;padding:20px;max-width:980px}
h1{font-size:20px;margin:0 0 4px}p.sub{color:var(--mute);margin:0 0 16px}
.row{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0;align-items:center}.row b{min-width:92px;color:var(--mute);font-weight:600}
button{border:1px solid #cfd3da;background:#fff;border-radius:999px;padding:5px 12px;font:inherit;cursor:pointer}
button.on{background:var(--ink);color:#fff;border-color:var(--ink)}
svg{width:100%;height:auto;background:#fff;border:1px solid #e4e6ea;border-radius:8px;margin-top:10px}
table{border-collapse:collapse;margin-top:14px;width:100%;background:#fff;border:1px solid #e4e6ea}
td,th{padding:6px 10px;text-align:right;border-bottom:1px solid #eef0f3}th:first-child,td:first-child{text-align:left}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}
.note{color:var(--mute);font-size:13px;margin-top:10px}
</style>
<h1>How fast are the songs?</h1>
<p class="sub" id="sub"></p>
<div class="row"><b>Era</b><span id="eras"></span></div>
<div class="row"><b>Tempo from</b><span id="srcs"></span></div>
<div class="row"><b>Split by feel</b><span id="split"></span></div>
<svg id="chart" viewBox="0 0 900 420"></svg>
<table id="tbl"></table>
<p class="note">Songs are counted from the tempo table. Tempo is in beats per minute, folded into 70 to 180 the way the app reads it. Dashed lines are the feel bands the app uses (slow under 90, mid 90 to 125, upbeat 125 and over). The feel label is a separate, hand-and-model judgement of how a song feels, so a "slow" song can measure faster than 90 and the colours overlap on purpose. Era is the release year (USDB, else the Billboard Year-End year); songs with no year appear only under All.</p>
<script>
const D=__DATA__, COL=['#3b82c4','#8a8f99','#e0663a','#c9ccd2'], NAMES=['slow','mid','upbeat','no label'];
const SRC=[['Combined (what the app uses)',0],['Deezer',1],['Beat tracker',2],['Note file',3]];
let era=-2, src=0, split=true;
const $=id=>document.getElementById(id);
function btns(el,items,get,set){el.innerHTML='';items.forEach(([l,v])=>{const b=document.createElement('button');b.textContent=l;b.className=get()===v?'on':'';b.onclick=()=>{set(v);draw()};el.appendChild(b)})}
const q=(a,p)=>a.length?a[Math.min(a.length-1,Math.floor(p*a.length))]:null;
function draw(){
  btns($('eras'),[['All',-2],...D.eras.map((e,i)=>[e,i])],()=>era,v=>era=v);
  btns($('srcs'),SRC.map(([l,i])=>[l,i]),()=>src,v=>src=v);
  btns($('split'),[['Yes',true],['No',false]],()=>split,v=>split=v);
  const pick=D.songs.filter(s=>s[src]!==null&&(era===-2||s[5]===era));
  $('sub').textContent=pick.length+' songs'+(era===-2?'':' in '+D.eras[era])+'. Bars are how many songs sit at each tempo (5 bpm per bar).';
  const lo=70,hi=180,W=5,nb=(hi-lo)/W,X0=50,X1=880,Y0=380,Y1=20;
  const bins=[0,1,2,3].map(()=>new Array(nb).fill(0));
  pick.forEach(s=>{const b=Math.min(nb-1,Math.max(0,Math.floor((s[src]-lo)/W)));bins[split?(s[4]<0?3:s[4]):3][b]++});
  const tot=bins[0].map((_,b)=>bins.reduce((a,x)=>a+x[b],0)), max=Math.max(1,...tot);
  const bw=(X1-X0)/nb, sy=v=>Y0-(v/max)*(Y0-Y1);
  let g='';
  for(let t=0;t<=4;t++){const v=Math.round(max*t/4),y=sy(v);g+='<line x1="'+X0+'" x2="'+X1+'" y1="'+y+'" y2="'+y+'" stroke="#eef0f3"/><text x="'+(X0-6)+'" y="'+(y+4)+'" text-anchor="end" font-size="11" fill="#6b7280">'+v+'</text>'}
  for(let b=0;b<nb;b++){let acc=0;for(let k=0;k<4;k++){const c=bins[k][b];if(!c)continue;const y=sy(acc+c),h=sy(acc)-y;g+='<rect x="'+(X0+b*bw+0.5)+'" y="'+y+'" width="'+(bw-1)+'" height="'+h+'" fill="'+COL[k]+'"/>';acc+=c}}
  for(let v=lo;v<=hi;v+=10){const x=X0+(v-lo)/W*bw;g+='<text x="'+x+'" y="'+(Y0+16)+'" text-anchor="middle" font-size="11" fill="#6b7280">'+v+'</text>'}
  [D.bands.mid.min,D.bands.upbeat.min].forEach(v=>{const x=X0+(v-lo)/W*bw;g+='<line x1="'+x+'" x2="'+x+'" y1="'+Y1+'" y2="'+Y0+'" stroke="#1f2430" stroke-dasharray="4 4"/>'});
  g+='<text x="'+(X0+(D.bands.mid.min-lo)/W*bw-6)+'" y="'+(Y1+12)+'" text-anchor="end" font-size="11">slow | mid</text><text x="'+(X0+(D.bands.upbeat.min-lo)/W*bw+6)+'" y="'+(Y1+12)+'" font-size="11">mid | upbeat</text>';
  g+='<text x="465" y="414" text-anchor="middle" font-size="12" fill="#6b7280">beats per minute</text>';
  if(split)NAMES.forEach((n,k)=>{g+='<rect x="'+(X1-330+k*80)+'" y="'+(Y1+22)+'" width="10" height="10" fill="'+COL[k]+'"/><text x="'+(X1-316+k*80)+'" y="'+(Y1+31)+'" font-size="11">'+n+'</text>'});
  $('chart').innerHTML=g;
  const rows=[['All songs',pick.map(s=>s[src])],...[0,1,2].map(f=>[NAMES[f]+' label',pick.filter(s=>s[4]===f).map(s=>s[src])]),['no label',pick.filter(s=>s[4]<0).map(s=>s[src])]];
  $('tbl').innerHTML='<tr><th></th><th>songs</th><th>fastest 10%</th><th>25%</th><th>median</th><th>75%</th><th>slowest 10%</th></tr>'.replace('fastest 10%','10th pct').replace('slowest 10%','90th pct')+rows.map(([n,a],i)=>{a.sort((x,y)=>x-y);const f=v=>v===null?'':Math.round(v);return '<tr><td>'+(i>0&&i<4?'<span class="sw" style="background:'+COL[i-1]+'"></span>':i===4?'<span class="sw" style="background:'+COL[3]+'"></span>':'')+n+'</td><td>'+a.length+'</td><td>'+f(q(a,.1))+'</td><td>'+f(q(a,.25))+'</td><td>'+f(q(a,.5))+'</td><td>'+f(q(a,.75))+'</td><td>'+f(q(a,.9))+'</td></tr>'}).join('');
}
draw();
</script>`;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
