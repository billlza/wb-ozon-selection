/** Lossless prompt representation. Persistence and output citations keep their original values. */
export const C1_GATEWAY_COMPACT_ENCODING_VERSION = 'c1-gateway-input-compact-v1';
export const C1_GATEWAY_INPUT_ENCODING_INSTRUCTION = '以下为无损编码：$p:[n,suffix]表示prefixes[n]+suffix；$s:n取strings[n]（其中$p同样展开）；$table:[columns,rows]按列名逐行还原对象数组；$map:[keys,columns,rows]按keys还原对象映射；$object保留原对象键名。先完整展开再理解。全部事实、来源、字段含义及图片文字均保留；factRefs、evidenceRefs等输出必须使用完整原值，禁止输出编码标签或索引。';

const TAGS = new Set(['$s', '$p', '$table', '$map', '$object']);
const MAX_DEPTH = 64;

function invalid(reason) {
  throw new Error(`C1_GATEWAY_INPUT_ENCODING_INVALID: ${reason}`);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function assertDepth(depth) {
  if (depth > MAX_DEPTH) invalid('nesting depth exceeds the supported JSON contract');
}

function countStrings(value, counts, ancestors = new Set(), depth = 0, maxDepth = MAX_DEPTH) {
  if (depth > maxDepth) invalid('nesting depth exceeds the supported JSON contract');
  if (typeof value === 'string') {
    counts.set(value, (counts.get(value) || 0) + 1);
    return;
  }
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (!Array.isArray(value) && !object(value)) invalid('payload must contain only JSON values');
  if (ancestors.has(value)) invalid('cyclic payload');
  if (Object.getOwnPropertySymbols(value).length) invalid('symbol keys are not JSON');
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) invalid('sparse arrays are not supported');
      countStrings(value[index], counts, ancestors, depth + 1, maxDepth);
    }
    if (Object.keys(value).length !== value.length) invalid('array properties are not JSON');
  } else {
    for (const item of Object.values(value)) countStrings(item, counts, ancestors, depth + 1, maxDepth);
  }
  ancestors.delete(value);
}

function tableColumns(value) {
  if (value.length < 2 || !object(value[0])) return null;
  const columns = Object.keys(value[0]);
  if (!columns.length) return null;
  const signature = JSON.stringify(columns);
  return value.every(row => object(row) && JSON.stringify(Object.keys(row)) === signature) ? columns : null;
}

function sharedPrefixes(values) {
  const groups = new Map();
  for (const value of values) {
    if (value.length <= 40) continue;
    const group = value.slice(0, 24);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(value);
  }
  const prefixes = [], indexes = new Map();
  for (const values of groups.values()) {
    if (values.length < 2) continue;
    let prefix = values[0];
    for (const value of values) {
      let index = 0;
      while (index < Math.min(prefix.length, value.length) && prefix[index] === value[index]) index += 1;
      prefix = prefix.slice(0, index);
    }
    if ((prefix.length - 16) * values.length <= prefix.length + 3) continue;
    const index = prefixes.length;
    prefixes.push(prefix);
    for (const value of values) indexes.set(value, index);
  }
  return { prefixes, indexes };
}

export function encodeC1GatewayInput(payload) {
  if (!object(payload)) invalid('payload must be a JSON object');
  const counts = new Map();
  countStrings(payload, counts);
  // Include a value only when its repetition pays for the table entry and reference tokens.
  const strings = [...counts].filter(([value, count]) =>
    count > 1 && (JSON.stringify(value).length - 12) * (count - 1) > 12).map(([value]) => value);
  const indexes = new Map(strings.map((value, index) => [value, index]));
  const shared = sharedPrefixes(counts.keys());
  function encodeText(value) {
    const index = shared.indexes.get(value);
    return index === undefined ? value : { $p: [index, value.slice(shared.prefixes[index].length)] };
  }
  function encode(value) {
    if (typeof value === 'string' && indexes.has(value)) return { $s: indexes.get(value) };
    if (typeof value === 'string') return encodeText(value);
    if (Array.isArray(value)) {
      const columns = tableColumns(value);
      return columns ? { $table: [columns, value.map(row => columns.map(key => encode(row[key])))] } : value.map(encode);
    }
    if (object(value)) {
      const keys = Object.keys(value), rows = Object.values(value), columns = tableColumns(rows);
      if (columns && !keys.some(key => TAGS.has(key))) {
        return { $map: [keys, columns, rows.map(row => columns.map(key => encode(row[key])))] };
      }
      const encoded = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
      return Object.keys(value).some(key => TAGS.has(key)) ? { $object: encoded } : encoded;
    }
    return value;
  }
  return { encodingVersion: C1_GATEWAY_COMPACT_ENCODING_VERSION, prefixes: shared.prefixes,
    strings: strings.map(encodeText), data: encode(payload) };
}

export function decodeC1GatewayInput(encoded) {
  if (!object(encoded) || Object.keys(encoded).length !== 4 ||
      encoded.encodingVersion !== C1_GATEWAY_COMPACT_ENCODING_VERSION ||
      !Array.isArray(encoded.prefixes) || !encoded.prefixes.every(value => typeof value === 'string') ||
      !Array.isArray(encoded.strings) ||
      !Object.hasOwn(encoded, 'data')) invalid('unsupported encoding envelope');
  // Reject cyclic/non-JSON input before interpreting markers. No file, network or executable references exist.
  countStrings(encoded, new Map(), new Set(), 0, MAX_DEPTH * 3 + 4);
  function decodeText(value) {
    if (typeof value === 'string') return value;
    if (!object(value) || Object.keys(value).length !== 1 || !Array.isArray(value.$p) || value.$p.length !== 2 ||
        !Number.isInteger(value.$p[0]) || value.$p[0] < 0 || value.$p[0] >= encoded.prefixes.length ||
        typeof value.$p[1] !== 'string') invalid('prefix reference is invalid');
    return encoded.prefixes[value.$p[0]] + value.$p[1];
  }
  const strings = encoded.strings.map(decodeText);
  function decodeObject(value, depth) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item, depth + 1)]));
  }
  function decode(value, depth = 0) {
    assertDepth(depth);
    if (Array.isArray(value)) return value.map(item => decode(item, depth + 1));
    if (!object(value)) return value;
    const markers = Object.keys(value).filter(key => TAGS.has(key));
    if (!markers.length) return decodeObject(value, depth);
    if (markers.length !== 1 || Object.keys(value).length !== 1) invalid('ambiguous encoding marker');
    if (markers[0] === '$s') {
      if (!Number.isInteger(value.$s) || value.$s < 0 || value.$s >= encoded.strings.length) invalid('string reference is out of range');
      return strings[value.$s];
    }
    if (markers[0] === '$p') return decodeText(value);
    if (markers[0] === '$object') {
      if (!object(value.$object)) invalid('escaped object must be an object');
      return decodeObject(value.$object, depth);
    }
    const mapped = markers[0] === '$map';
    const table = mapped ? value.$map : value.$table;
    if (!Array.isArray(table) || table.length !== (mapped ? 3 : 2)) invalid('table must contain columns and rows');
    const [columns, rows] = mapped ? table.slice(1) : table;
    if (!Array.isArray(columns) || !columns.length || columns.some(column => typeof column !== 'string') ||
        new Set(columns).size !== columns.length || !Array.isArray(rows) || rows.length < 2 ||
        rows.some(row => !Array.isArray(row) || row.length !== columns.length)) invalid('table columns and rows do not match');
    const restored = rows.map(row => Object.fromEntries(columns.map((column, index) => [column, decode(row[index], depth + 1)])));
    if (!mapped) return restored;
    const keys = table[0];
    if (!Array.isArray(keys) || keys.length !== restored.length || keys.some(key => typeof key !== 'string') ||
        new Set(keys).size !== keys.length) invalid('map keys do not match table rows');
    return Object.fromEntries(keys.map((key, index) => [key, restored[index]]));
  }
  const result = decode(encoded.data);
  if (!object(result)) invalid('decoded payload must be an object');
  countStrings(result, new Map());
  return result;
}
