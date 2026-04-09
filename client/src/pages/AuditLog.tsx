import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Bot, User, FileText, Shield, CheckCircle, AlertTriangle, Settings } from "lucide-react";

const AI_ACTIONS = new Set([
  "ai_screening", "ai_agent_routing", "frame_analysis", "auto_ai_screening",
  "ai_review_complete", "ai_suggestion",
]);

function isAiAction(action: string) {
  return AI_ACTIONS.has(action) || action.startsWith("ai_");
}

const humanActionIcons: Record<string, any> = {
  create_ad: FileText, update_ad: FileText,
  submit_review: CheckCircle,
  create_policy: Shield, update_policy: Shield, delete_policy: Shield,
  create_advertiser: User, update_advertiser: User, update_role: User,
  login: User,
};

function ActionIcon({ action }: { action: string }) {
  if (isAiAction(action)) return <Bot className="h-4 w-4 text-purple-700" />;
  const Icon = humanActionIcons[action] || Settings;
  return <Icon className="h-4 w-4 text-blue-600" />;
}

function formatDetails(details: any): string {
  if (!details) return "";
  const skip = new Set(["routingReason"]);
  return Object.entries(details)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${(v as any[]).join(", ")}]`;
      return `${k}: ${v}`;
    })
    .join(" · ");
}

export default function AuditLog() {
  const { data: logs, isLoading } = trpc.audit.list.useQuery({});

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Agent Activity</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Full history of AI agent decisions and human actions on the platform.
        </p>
      </div>

      <Card className="bg-card border-border">
        <CardHeader className="pb-3 pt-4 px-4">
          <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <div className="h-5 w-5 rounded bg-purple-50 flex items-center justify-center">
                <Bot className="h-3 w-3 text-purple-700" />
              </div>
              AI agent action
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-5 w-5 rounded bg-blue-50 flex items-center justify-center">
                <User className="h-3 w-3 text-blue-600" />
              </div>
              Human action
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : logs && logs.length > 0 ? (
            <div className="divide-y divide-border/50">
              {logs.map(log => {
                const ai = isAiAction(log.action);
                const details = log.details as any;
                return (
                  <div key={log.id} className={`flex items-start gap-3 p-3 hover:bg-accent/30 transition-colors ${ai ? "border-l-2 border-l-purple-500/30" : ""}`}>
                    <div className={`h-8 w-8 rounded-md flex items-center justify-center shrink-0 ${ai ? "bg-purple-50" : "bg-blue-50"}`}>
                      <ActionIcon action={log.action} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium capitalize">{log.action.replace(/_/g, " ")}</span>
                        {ai ? (
                          <Badge variant="outline" className="text-[10px] bg-purple-50 text-purple-700 border-purple-200 h-4 px-1.5">
                            AI Agent
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-600 border-blue-200 h-4 px-1.5">
                            Human
                          </Badge>
                        )}
                        {details?.routingDecision && (
                          <Badge variant="outline" className={`text-[10px] h-4 px-1.5 ${
                            details.routingDecision === "auto_approve" ? "bg-green-500/15 text-green-600 border-green-300" :
                            details.routingDecision === "auto_reject" ? "bg-red-500/15 text-red-600 border-red-300" :
                            "bg-yellow-500/15 text-amber-600 border-amber-300"
                          }`}>
                            {details.routingDecision.replace(/_/g, " ")}
                          </Badge>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        <span className="text-muted-foreground/70">{log.entityType} #{log.entityId}</span>
                        {details && <span> · {formatDetails(details)}</span>}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[11px] text-muted-foreground">{new Date(log.createdAt).toLocaleString()}</p>
                      {log.userId && <p className="text-[10px] text-muted-foreground/60">User #{log.userId}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-12">
              <Bot className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No activity yet. Actions will appear here as the platform is used.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
