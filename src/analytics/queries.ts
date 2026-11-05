import library from 'node-sql-parser/build/sqlite.js';
import { record } from './normalize';

export const TABLES=['analysis_vehicles','analysis_predictions','analysis_routes','analysis_stops','analysis_reference_captures','analysis_collections','analysis_runs','analysis_stop_visits'] as const;
export const PREVIEW_LIMIT=500,EXPORT_LIMIT=10000,MAX_BYTES=8*1024*1024;
const functions=new Set(('abs avg cast ceil ceiling char coalesce concat concat_ws count cume_dist date datetime dense_rank exp first_value floor format glob group_concat hex if ifnull iif instr json json_array json_array_length json_each json_error_position json_extract json_group_array json_group_object json_insert json_object json_patch json_pretty json_quote json_remove json_replace json_set json_tree json_type json_valid jsonb jsonb_array jsonb_extract jsonb_group_array jsonb_group_object jsonb_insert jsonb_object jsonb_patch jsonb_remove jsonb_replace jsonb_set julianday lag last_value lead length likelihood likely ln log log10 log2 lower ltrim max min mod nth_value ntile nullif octet_length percent_rank pi pow power printf quote radians rank replace round row_number rtrim sign sin cos tan sqrt strftime string_agg substr substring sum time timediff total trim trunc typeof unhex unicode unixepoch unlikely upper current_date current_time current_timestamp').split(' '));
const parser=new library.Parser();
type Node=Record<string,unknown>;
function functionName(value:unknown):string {
  if(typeof value==='string')return value.toLowerCase();
  const n=record(value);
  if(!Array.isArray(n.name) || n.name.length!==1)throw Error('Qualified function names are not supported');
  return String(record(n.name[0]).value).toLowerCase();
}
function select(value:unknown,inherited:Set<string>,depth=0):void {
  if(depth>30)throw Error('Query nesting is too deep');
  const node=record(value);
  if(node.type!=='select')throw Error('Only a single read-only SELECT or WITH query is allowed');
  if(node.into || node.for_update || node.locking_read)throw Error('Only read-only queries are allowed');
  const scope=new Set(inherited);
  if(node.with) {
    if(!Array.isArray(node.with))throw Error('Invalid WITH clause');
    for(const item of node.with) {
      const cte=record(item),name=String(record(cte.name).value).toLowerCase();
      if(cte.recursive)throw Error('Recursive queries are not supported');
      if(TABLES.includes(name as typeof TABLES[number]) || scope.has(name))throw Error('Use a distinct CTE name');
      // Validate in declaration order: self/forward references cannot access hidden tables.
      select(record(cte.stmt).ast,scope,depth+1);scope.add(name);
    }
  }
  function walk(v:unknown):void {
    if(Array.isArray(v)){v.forEach(walk);return;}
    if(!v || typeof v!=='object')return;
    const n=v as Node;
    if(n.type==='select'){select(n,scope,depth+1);return;}
    if(n.type==='function' || n.type==='aggr_func') {
      if(!functions.has(functionName(n.name)))throw Error('This function is not supported in the read-only editor');
    }
    if(n.type==='param' || n.type==='var' || (n.type==='origin' && n.value==='?'))throw Error('Use literal values instead of query parameters');
    Object.values(n).forEach(walk);
  }
  if(node.from) {
    if(!Array.isArray(node.from))throw Error('Invalid FROM clause');
    for(const item of node.from) {
      const from=record(item);
      if(from.table!==undefined) {
        const table=String(from.table).toLowerCase();
        if(from.db || (!TABLES.includes(table as typeof TABLES[number]) && !scope.has(table)))throw Error('Query only the analysis views listed in the schema browser');
      } else if(!from.expr)throw Error('Unsupported data source');
      walk(from.expr);walk(from.on);
    }
  }
  for(const [key,v] of Object.entries(node))if(key!=='with' && key!=='from')walk(v);
}
export function readOnlySql(input:unknown):string {
  if(typeof input!=='string' || !input.trim() || new TextEncoder().encode(input).length>20000)throw Error('Enter a query of at most 20 KB');
  let ast:unknown;
  // The pinned parser requires PARTITION BY in window clauses. A constant partition
  // is equivalent to omitting it. Mask literals/comments so their contents never change.
  const masked=input.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|--[^\r\n]*|\/\*[\s\S]*?\*\//g,text=>' '.repeat(text.length));
  const positions=Array.from(masked.matchAll(/\bOVER\s*\(\s*(?=ORDER\b|\))/gi),match=>match.index!+match[0].length);
  let compatible=input;
  for(const position of positions.reverse())compatible=compatible.slice(0,position)+'PARTITION BY 1 '+compatible.slice(position);
  try {ast=parser.astify(compatible);}catch{throw Error('Could not parse this SQLite query. Use SELECT or WITH with double-quoted identifiers.');}
  if(Array.isArray(ast)){if(ast.length!==1)throw Error('Run one query at a time');ast=ast[0];}
  select(ast,new Set());
  // Execute the validated AST serialization, never the original input.
  return parser.sqlify(ast as Parameters<typeof parser.sqlify>[0]);
}
export async function query(db:D1Database,input:unknown,limit:number) {
  const sql=readOnlySql(input);
  const plan=await db.prepare('EXPLAIN '+sql).all<{opcode:string;p2:number}>();
  if(plan.results.some(op=>op.opcode==='OpenWrite' || op.opcode==='VUpdate' || (op.opcode==='Transaction' && op.p2!==0)))throw Error('Query is not read-only');
  const at=Date.now();
  const raw=await db.prepare(`SELECT * FROM (${sql}) AS query_result LIMIT ?`).bind(limit+1).raw<unknown[]>({columnNames:true});
  const columns=(raw.shift()??[]).map(String);
  if(columns.length>100)throw Error('Select at most 100 columns');
  const truncated=raw.length>limit,rows=raw.slice(0,limit);
  const bytes=new TextEncoder().encode(JSON.stringify({columns,rows})).length;
  if(bytes>MAX_BYTES)throw Error('Result exceeds 8 MiB. Select fewer rows or columns.');
  return {columns,rows,truncated,row_limit:limit,duration_ms:Date.now()-at};
}
function cell(value:unknown):string {
  let s=value==null?'':typeof value==='object'?JSON.stringify(value):String(value);
  // Spreadsheet applications can execute formulas even inside quoted CSV cells.
  if(typeof value==='string' && (/^[\s]*[=+\-@]/.test(s) || /^[\t\r]/.test(s)))s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
}
export function csv(columns:string[],rows:unknown[][]):string {
  const text='\uFEFF'+[columns,...rows].map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
  if(new TextEncoder().encode(text).length>MAX_BYTES)throw Error('CSV exceeds 8 MiB. Narrow the query.');
  return text;
}
