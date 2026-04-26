import { type FormEvent, useEffect, useState } from "react";
import { Navigate } from "react-router";
import { localBootstrap } from "../api/auth.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";

const LOCAL_BOOTSTRAP_DISABLED_KEY = "first-tree-hub:local-bootstrap-disabled";

type BootstrapState = "probing" | "form";

export function LoginPage() {
  const { isAuthenticated, login, adoptTokens } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Probe `local-bootstrap` on mount. Local-mode minting is silent — the
  // user never sees a credentials form. Hosted mode (or any cross-origin
  // browser hitting a real Hub) returns 404/401 and we fall back to the
  // username/password form. The probe result is cached in sessionStorage
  // so re-mounts after a logout don't reprobe within the same tab.
  const [bootstrapState, setBootstrapState] = useState<BootstrapState>(() =>
    sessionStorage.getItem(LOCAL_BOOTSTRAP_DISABLED_KEY) === "1" ? "form" : "probing",
  );

  useEffect(() => {
    if (bootstrapState !== "probing") return;
    let cancelled = false;
    void (async () => {
      const tokens = await localBootstrap();
      if (cancelled) return;
      if (tokens) {
        await adoptTokens(tokens);
        return;
      }
      sessionStorage.setItem(LOCAL_BOOTSTRAP_DISABLED_KEY, "1");
      setBootstrapState("form");
    })();
    return () => {
      cancelled = true;
    };
  }, [adoptTokens, bootstrapState]);

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
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

  if (bootstrapState === "probing") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-title">First Tree</CardTitle>
            <CardDescription>Signing you in…</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-title">First Tree</CardTitle>
          <CardDescription>Sign in to your workspace</CardDescription>
        </CardHeader>
        <CardContent>
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
