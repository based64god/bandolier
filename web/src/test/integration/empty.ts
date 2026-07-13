// Stub that `server-only` is aliased to under the integration config. The real
// `server-only` throws when imported outside an RSC graph; routers/routes that
// (transitively) import it — e.g. ~/server/push — must load under plain Node in
// tests. Aliasing to this empty module is exactly what the RSC `react-server`
// export condition does in production.
export {};
