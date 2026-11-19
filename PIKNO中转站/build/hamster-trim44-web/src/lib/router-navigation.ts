// Load routes only after navigation, not on hover, focus, or touch intent.
export const routerNavigationOptions = {
  defaultPreload: false,
  defaultPreloadStaleTime: 0,
} as const
