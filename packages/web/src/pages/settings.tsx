import { SYSTEM_CONFIG_DEFAULTS, SYSTEM_CONFIG_KEYS } from "@agent-hub/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { getConfigs, updateConfigs } from "../api/system-config.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";

const CONFIG_LABELS: Record<string, string> = {
  [SYSTEM_CONFIG_KEYS.INBOX_TIMEOUT_SECONDS]: "Inbox Timeout (seconds)",
  [SYSTEM_CONFIG_KEYS.MAX_RETRY_COUNT]: "Max Retry Count",
  [SYSTEM_CONFIG_KEYS.POLLING_INTERVAL_SECONDS]: "Polling Interval (seconds)",
  [SYSTEM_CONFIG_KEYS.PRESENCE_CLEANUP_SECONDS]: "Presence Cleanup (seconds)",
};

const configKeys = Object.values(SYSTEM_CONFIG_KEYS);

export function SettingsPage() {
  const queryClient = useQueryClient();
  const { data: configs, isLoading } = useQuery({
    queryKey: ["system-config"],
    queryFn: getConfigs,
  });

  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!configs) return;
    const map: Record<string, string> = {};
    for (const key of configKeys) {
      const val = configs[key] ?? SYSTEM_CONFIG_DEFAULTS[key as keyof typeof SYSTEM_CONFIG_DEFAULTS] ?? "";
      map[key] = String(val);
    }
    setValues(map);
  }, [configs]);

  const mutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(values)) {
        const trimmed = val.trim();
        if (trimmed === "") {
          // Restore default instead of sending 0
          payload[key] = SYSTEM_CONFIG_DEFAULTS[key as keyof typeof SYSTEM_CONFIG_DEFAULTS] ?? 0;
        } else {
          const num = Number(trimmed);
          payload[key] = Number.isNaN(num) ? trimmed : num;
        }
      }
      return updateConfigs(payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["system-config"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };

  if (isLoading) {
    return <div className="text-muted-foreground">Loading...</div>;
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Settings</h1>
      <Card>
        <CardHeader>
          <CardTitle>System Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {configKeys.map((key) => (
              <div key={key} className="space-y-2">
                <Label htmlFor={key}>{CONFIG_LABELS[key] ?? key}</Label>
                <Input
                  id={key}
                  value={values[key] ?? ""}
                  onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Default: {String(SYSTEM_CONFIG_DEFAULTS[key as keyof typeof SYSTEM_CONFIG_DEFAULTS] ?? "—")}
                </p>
              </div>
            ))}
            {mutation.error instanceof Error && (
              <div className="text-sm text-destructive">{mutation.error.message}</div>
            )}
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
              {saved && <span className="text-sm text-green-600">Saved!</span>}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
