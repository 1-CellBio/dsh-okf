declare module "sql.js" {
  export type SqlValue = string | number | null | Uint8Array;
  export type BindParams = SqlValue[] | Record<string, SqlValue>;

  export interface Statement {
    bind(values?: BindParams): boolean;
    step(): boolean;
    getAsObject(): Record<string, SqlValue>;
    free(): boolean;
  }

  export interface Database {
    run(sql: string, params?: BindParams): Database;
    exec(sql: string): { columns: string[]; values: SqlValue[][] }[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer) => Database;
  }

  export interface InitSqlJsConfig {
    locateFile?: (file: string, prefix: string) => string;
  }

  export default function initSqlJs(config?: InitSqlJsConfig): Promise<SqlJsStatic>;
}
