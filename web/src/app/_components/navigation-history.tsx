"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";

import { usePathname } from "next/navigation";

// Tracks whether the user has navigated within the app since this document
// loaded. The root layout persists across App Router client navigations, so a
// provider mounted there keeps counting as usePathname changes. Pages use this
// to decide whether a "back" control can safely return to the previous in-app
// page (router.back()) or should fall back to a fixed href — a direct visit,
// deep link, or hard refresh starts with no prior entry.
const CanGoBackContext = createContext(false);

export function NavigationHistoryProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const previous = useRef(pathname);
  const [canGoBack, setCanGoBack] = useState(false);

  useEffect(() => {
    if (previous.current !== pathname) {
      previous.current = pathname;
      setCanGoBack(true);
    }
  }, [pathname]);

  return (
    <CanGoBackContext.Provider value={canGoBack}>
      {children}
    </CanGoBackContext.Provider>
  );
}

export function useCanGoBack() {
  return useContext(CanGoBackContext);
}
