import { DashboardEntry } from "~/app/_components/dashboard-entry";

export default async function RepoPage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  // slug is the repo full name split on "/", e.g. ["owner", "repo"].
  const repoSlug = slug.map(decodeURIComponent).join("/");
  return <DashboardEntry repoSlug={repoSlug} />;
}
