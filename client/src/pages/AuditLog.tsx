import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Settings, FileText, Shield, CheckCircle, Bot, Users, AlertTriangle } from "lucide-react";

export default function AuditLog() {
  const { data: logs, isLoading } = trpc.audit.list.useQuery({});

  const actionIcons: Record<string, any> = {
    create_ad: FileText,
    update_ad: FileText,
    ai_screening: Bot,
    submit_review: CheckCircle,
    create_policy: Shield,
    update_policy: Shield,
    delete_policy: Shield,
    create_advertiser: Users,
    update_advertiser: Users,
    update_role: Users,
  };

  const actionColors: Record<string, string> = {
    create_ad: "text-blue-400",
    update_ad: "text-yellow-400",
    ai_screening: "text-purple-400",
    submit_review: "text-green-400",
    create_policy: "text-primary",
    delete_policy: "text-destructive",
    update_role: "text-orange-400",
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Audit Log</h1>
        <p className="text-sm text-muted-foreground mt-1">Complete history of all platform actions and changes.</p>
      </div>

      <Card className="bg-card border-border">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : logs && logs.length > 0 ? (
            <div className="divide-y divide-border/50">
              {logs.map(log => {
                const Icon = actionIcons[log.action] || Settings;
                const color = actionColors[log.action] || "text-muted-foreground";
                const details = log.details as any;
                return (
                  <div key={log.id} className="flex items-center gap-3 p-3 hover:bg-accent/30 transition-colors">
                    <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center shrink-0">
                      <Icon className={`h-4 w-4 ${color}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm">
                        <span className="font-medium capitalize">{log.action.replace(/_/g, " ")}</span>
                        <span className="text-muted-foreground"> on </span>
                        <span className="font-medium">{log.entityType}</span>
                        {log.entityId && <span className="text-muted-foreground"> #{log.entityId}</span>}
                      </p>
                      {details && (
                        <p className="text-[11px] text-muted-foreground truncate">
                          {Object.entries(details).map(([k, v]) => `${k}: ${v}`).join(" · ")}
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[11px] text-muted-foreground">{new Date(log.createdAt).toLocaleString()}</p>
                      {log.userId && <p className="text-[10px] text-muted-foreground">User #{log.userId}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-12">
              <Settings className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No audit entries yet. Actions will be logged as you use the platform.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
