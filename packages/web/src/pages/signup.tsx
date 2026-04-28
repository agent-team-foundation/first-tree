import { Github } from "lucide-react";
import { Link, Navigate, useSearchParams } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";

/**
 * Public signup page — single button "Continue with GitHub". The OAuth
 * round-trip lands on `/auth/github/complete` (the fragment consumer)
 * which warms the auth context and bounces the user to the appropriate
 * landing (`/welcome` for first-time, `/` otherwise).
 */
export function SignupPage() {
  const { isAuthenticated } = useAuth();
  const [params] = useSearchParams();

  if (isAuthenticated) return <Navigate to="/" replace />;

  // Forward `?next=<safe-path>` into the OAuth start URL so we land on the
  // intended page (e.g. /invite/<token>) once the user signs in.
  const next = params.get("next") ?? "";
  const startUrl = next ? `/api/v1/auth/github/start?next=${encodeURIComponent(next)}` : "/api/v1/auth/github/start";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-title">Join First Tree</CardTitle>
          <CardDescription>Create your team in under a minute</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button asChild className="w-full">
            <a href={startUrl}>
              <Github className="h-4 w-4" />
              Continue with GitHub
            </a>
          </Button>
          <div className="text-center text-label text-muted-foreground">
            Already on a team?{" "}
            <Link to="/login" className="underline">
              Sign in
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
