import { Github } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Navigate, useLocation } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { readFromPath } from "../auth/redirect-from-state.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";

export function LoginPage() {
  const { isAuthenticated, login } = useAuth();
  const location = useLocation();
  const redirectTo = readFromPath(location.state) ?? "/";
  // GitHub OAuth is a full-page navigation, so React Router state is
  // dropped on the way out. Pass the deep-link target through the
  // server's `?next=` instead — the server validates it via the same
  // safeRedirectPath helper and bakes it into the state JWT, so the
  // post-callback fragment carries it back to OAuthCompletePage.
  const githubHref =
    redirectTo === "/"
      ? "/api/v1/auth/github/start"
      : `/api/v1/auth/github/start?next=${encodeURIComponent(redirectTo)}`;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (isAuthenticated) {
    return <Navigate to={redirectTo} replace />;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-title">First Tree</CardTitle>
          <CardDescription>Sign in to your workspace</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button asChild variant="outline" className="w-full">
            <a href={githubHref}>
              <Github className="h-4 w-4" />
              Continue with GitHub
            </a>
          </Button>
          <div className="relative my-2 text-center text-label text-muted-foreground">
            <span className="bg-card px-2 relative z-10">or sign in with username</span>
            <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && <div className="rounded-md bg-destructive/10 p-3 text-body text-destructive">{error}</div>}
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
