export function frozenResponse() {
  return Response.json({ error: 'STORAGE_MIGRATION_IN_PROGRESS' }, {
    status: 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export function freezeStorageRoutes(worker, routes) {
  return {
    ...worker,
    fetch(request, env, context) {
      const path = new URL(request.url).pathname;
      if (routes[request.method]?.includes(path)) return frozenResponse();
      return worker.fetch(request, env, context);
    },
  };
}
