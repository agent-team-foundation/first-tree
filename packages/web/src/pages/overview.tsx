import { useQuery } from "@tanstack/react-query";
import { Bot, MessageSquare, Radio } from "lucide-react";
import { getOverview } from "../api/overview.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";

export function OverviewPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["overview"],
    queryFn: getOverview,
    refetchInterval: 30_000,
  });

  const stats = [
    { label: "Total Agents", value: data?.agents, icon: Bot },
    { label: "Online Agents", value: data?.onlineAgents, icon: Radio },
    { label: "Total Chats", value: data?.chats, icon: MessageSquare },
  ];

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Overview</h1>
      <div className="grid gap-4 md:grid-cols-3">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{stat.label}</CardTitle>
              <stat.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{isLoading ? "..." : (stat.value ?? "—")}</div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
