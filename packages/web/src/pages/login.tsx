import { Github } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Navigate, useLocation } from "react-router";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";

/**
 * Type guard for the {from: Location} state set by RequireAuth when it
 * redirects an unauthenticated deep-link visitor to /login. router-7 types
 * `location.state` as `unknown`, so we narrow without casts.
 */
function readFromPath(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  if (!("from" in state)) return null;
  const from = state.from;
  if (typeof from !== "object" || from === null) return null;
  if (!("pathname" in from) || typeof from.pathname !== "string") return null;
  const search = "search" in from && typeof from.search === "string" ? from.search : "";
  const hash = "hash" in from && typeof from.hash === "string" ? from.hash : "";
  // Refuse to bounce back to /login itself — that would loop.
  if (from.pathname === "/login") return null;
  return `${from.pathname}${search}${hash}`;
}

export function LoginPage() {
  const { isAuthenticated, login } = useAuth();
  const location = useLocation();
  const redirectTo = readFromPath(location.state) ?? "/";
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
            <a href="/api/v1/auth/github/start">
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
