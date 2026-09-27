// Minimal runtime contract; importing this declaration never loads Bun in Node.
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options: { readonly: boolean; create: boolean });
    prepare(sql: string): {
      run(...args: (string | number | null)[]): { lastInsertRowid: number | bigint };
      all(...args: (string | number | null)[]): Record<string, string | number | null>[];
    };
    exec(sql: string): unknown;
    close(): unknown;
  }
}
