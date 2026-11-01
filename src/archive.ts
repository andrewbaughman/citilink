import { API_BASE, type DatasetId } from './plan';
export interface Bucket {
  get?(key: string): Promise<{text(): Promise<string>} | null>;
  put(key: string, value: string | ArrayBuffer | Uint8Array, options?: { httpMetadata: { contentType: string } }): Promise<unknown>;
}
export const jsonOptions = { httpMetadata: { contentType: 'application/json' } };
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export async function sha256(bytes: Uint8Array | string) {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource))].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function base64(bytes: Uint8Array) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 16384) result += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(result);
}
const HEADER_ALLOWLIST = ['content-type','content-length','content-encoding','date','age','etag','last-modified','cache-control','retry-after','expires','vary'];
export function safeHeaders(headers: Headers) {
  const values: Record<string,string> = {};
  for (const name of HEADER_ALLOWLIST) {
    const value = headers.get(name);
    if (value !== null) values[name] = value;
  }
  return values;
}
export async function readBody(response: Response): Promise<{ bytes: Uint8Array; complete: boolean; error?: string }> {
  if (!response.body) return { bytes: new Uint8Array(), complete: true };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0, complete = true, error: string | undefined;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const remaining = MAX_BODY_BYTES - size;
      if (part.value.length > remaining) {
        chunks.push(part.value.subarray(0, remaining)); size += remaining;
        complete = false; error = 'response_size_limit_exceeded';
        await reader.cancel(); break;
      }
      chunks.push(part.value); size += part.value.length;
    }
  } catch { complete = false; error = 'body_stream_failed'; }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) { bytes.set(part,offset); offset += part.length; }
  return { bytes, complete, error };
}
export function parseJson(bytes: Uint8Array): { value?: unknown; valid: boolean } {
  try { return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)), valid: true }; }
  catch { return { valid: false }; }
}
export function structurallyValid(id: DatasetId, value: unknown): boolean {
  if (id === 'service_messages') return Array.isArray(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const field = { vehicles: 'vehicule', topology_updates: 'update', config_version: 'version', full_topology: 'topo', stop_predictions: 'listeHoraires' }[id];
  return Array.isArray((value as Record<string,unknown>)[field]);
}
export function pathFor(slot: number) { return new Date(slot).toISOString().slice(0,16).replaceAll('-', '/').replace('T','/').replace(':','/'); }
export function upstreamUrl(id: DatasetId, at: number, stopId?: number) {
  const paths = { vehicles:'/topo/vehicules', topology_updates:'/topo/refresh', service_messages:'/iv/message', config_version:'/config/version', full_topology:'/topo', stop_predictions:`/horaires/pta/${stopId}` };
  if (id === 'stop_predictions' && (!Number.isSafeInteger(stopId) || stopId! <= 0)) throw Error('Invalid stop ID');
  return `${API_BASE}${paths[id]}?_tmp=${at}`;
}
export function stopRoster(value: unknown): number[] {
  const topology = (value as { topo?: { pointArret?: { idPointArret?: number }[] }[] })?.topo;
  const ids = (topology ?? []).flatMap(ce => (ce.pointArret ?? []).map(s => s.idPointArret)).filter((id): id is number => Number.isSafeInteger(id) && id! > 0);
  return [...new Set(ids)].sort((a,b) => a-b);
}
