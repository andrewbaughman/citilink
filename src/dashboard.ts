export const dashboard = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Citilink archive</title>
<style>
:root{color-scheme:light dark;font:16px system-ui,sans-serif;background:#101820;color:#eaf0f4}body{max-width:1100px;margin:40px auto;padding:0 22px}h1{margin-bottom:4px}p{color:#b9c9d7;line-height:1.6}.badge{padding:6px 12px;border:1px solid #54697a;border-radius:20px;display:inline-block}table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;padding:12px 8px;border-bottom:1px solid #304453}th{color:#a9d0e5}code{overflow-wrap:anywhere}a{color:#9ad9ff}section{margin-top:30px}button,input{padding:9px;border:1px solid #54697a;border-radius:6px;background:#1b2e3c;color:inherit}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}.scroll{overflow:auto}.good{color:#92e3b2}.bad{color:#ffb0a5}small{color:#b9c9d7}label{display:block;margin-bottom:8px}
</style></head><body><h1>Citilink archive</h1><p>Raw JSON history · Fort Wayne, Indiana</p><span class="badge" id="health">Loading status…</span>
<p id="summary"></p><section><h2>Collection</h2><div class="scroll"><table><thead><tr><th>Dataset</th><th>Cadence</th><th>State</th><th>Last saved</th><th>Coverage</th><th>Details</th></tr></thead><tbody id="feeds"></tbody></table></div></section>
<section><h2>Request budget</h2><p id="budget"></p><p id="cooldown"></p></section>
<section><h2>Recent collection runs</h2><ul id="runs"></ul><small>Downloads are original JSON responses and JSON manifests. The private bucket is never publicly listed.</small></section>
<section><h2>Download JSON</h2><form id="download"><label for="key">Object key from a manifest</label><input id="key" style="width:70%" required placeholder="raw/v1/…/response.json"><button>Download</button></form></section>
<section><h2>Diagnostics</h2><pre id="errors"></pre><details><summary>Full operational status and known stop IDs</summary><pre id="full"></pre></details></section>
<p><small>Times use America/Indiana/Indianapolis. Status refreshes once per minute. <a href="https://github.com/andrewbaughman/citilink">Source and runbook</a></small></p>
<script>
const date = n => n == null ? 'Not yet' : new Date(n).toLocaleString('en-US',{timeZone:'America/Indiana/Indianapolis'});
const text = (id,v) => document.getElementById(id).textContent=v;
async function refresh(){try{
 const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw Error('Status unavailable ('+r.status+')');const s=await r.json();
 text('health',s.healthy?'Collecting normally':'Needs attention');document.getElementById('health').className='badge '+(s.healthy?'good':'bad');
 text('summary','Last tick: '+date(s.last_tick)+' · Configuration '+s.plan_hash.slice(0,12)+' · '+s.roster_count+' known stops');
 const tbody=document.getElementById('feeds');tbody.replaceChildren();
 for(const [id,d] of Object.entries(s.datasets)){const row=document.createElement('tr');for(const value of [id,d.cadence_minutes+' min',!d.enabled?'Disabled':d.warming_up?'Warming up':d.healthy?'Healthy':'Degraded',date(d.last_archived_at),d.coverage==null?'—':d.coverage.toFixed(0)+'%',d.last_error||'—']){const td=document.createElement('td');td.textContent=value;row.append(td);}tbody.append(row);}
 text('budget',s.budget.total+' / '+s.daily_limit+' requests today (UTC). Optional: '+s.budget.optional+'. Base plan: '+s.estimate.total+'/day.');
 text('cooldown',s.cooldown_until>s.now?'Upstream requests paused until '+date(s.cooldown_until):'No upstream cooldown.');
 const runs=document.getElementById('runs');runs.replaceChildren();for(const run of s.recent_runs){const li=document.createElement('li'),a=document.createElement('a');a.href='/api/archive?key='+encodeURIComponent(run.key);a.textContent=date(run.slot)+' — '+run.status;li.append(a);runs.append(li);}
 text('errors',JSON.stringify({reasons:s.reasons,errors:s.errors},null,2));text('full',JSON.stringify(s,null,2));
 }catch(e){text('health','Status unavailable');document.getElementById('health').className='badge bad';text('summary',e.message);}}
document.getElementById('download').addEventListener('submit',e=>{e.preventDefault();window.location.assign('/api/archive?key='+encodeURIComponent(document.getElementById('key').value));});
refresh();setInterval(refresh,60000);
</script></body></html>`;
