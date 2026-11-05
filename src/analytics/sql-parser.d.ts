declare module 'node-sql-parser/build/sqlite.js' {
  import { Parser } from 'node-sql-parser';
  const library: { Parser: typeof Parser };
  export default library;
}
