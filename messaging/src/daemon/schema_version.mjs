// A leaf on purpose: doctor (bin/tightbeam) reads the version without loading
// the migrations and the daemon ops behind them, some of which import outside messaging/.
export const SCHEMA_VERSION = 32;
