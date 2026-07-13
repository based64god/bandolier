"use client";

import { useRouter } from "next/navigation";

import { authClient } from "~/server/better-auth/client";

export function SignInButton() {
  return (
    <button
      onClick={() =>
        authClient.signIn.social({ provider: "github", callbackURL: "/" })
      }
      className="rounded-full bg-white/10 px-10 py-3 font-semibold no-underline transition hover:bg-white/20"
    >
      Sign in with Github
    </button>
  );
}

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await authClient.signOut();
        router.refresh();
      }}
      className="rounded-full bg-white/10 px-10 py-3 font-semibold no-underline transition hover:bg-white/20"
    >
      Sign out
    </button>
  );
}
