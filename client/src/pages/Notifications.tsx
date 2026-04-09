import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Bell, CheckCheck, FileText, Bot, Shield, AlertTriangle, CheckCircle, Clock } from "lucide-react";
import { useLocation } from "wouter";

export default function Notifications() {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const { data: notifications, isLoading } = trpc.notifications.list.useQuery();
  const { data: unreadCount } = trpc.notifications.unreadCount.useQuery();

  const markRead = trpc.notifications.markRead.useMutation({
    onSuccess: () => { utils.notifications.list.invalidate(); utils.notifications.unreadCount.invalidate(); },
  });

  const markAllRead = trpc.notifications.markAllRead.useMutation({
    onSuccess: () => { utils.notifications.list.invalidate(); utils.notifications.unreadCount.invalidate(); },
  });

  const typeIcons: Record<string, any> = {
    ad_submitted: FileText,
    ai_screening_complete: Bot,
    review_assigned: Shield,
    review_completed: CheckCircle,
    escalation: AlertTriangle,
    policy_violation: AlertTriangle,
    approval_needed: Clock,
    status_change: FileText,
    system: Bell,
  };

  const typeColors: Record<string, string> = {
    ad_submitted: "text-blue-600",
    ai_screening_complete: "text-purple-700",
    review_completed: "text-green-400",
    escalation: "text-orange-400",
    policy_violation: "text-red-400",
    status_change: "text-yellow-400",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {(unreadCount ?? 0) > 0 ? `${unreadCount} unread notifications` : "All caught up"}
          </p>
        </div>
        {(unreadCount ?? 0) > 0 && (
          <Button variant="outline" size="sm" onClick={() => markAllRead.mutate()}>
            <CheckCheck className="h-4 w-4 mr-1.5" />
            Mark All Read
          </Button>
        )}
      </div>

      <Card className="bg-card border-border">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : notifications && notifications.length > 0 ? (
            <div className="divide-y divide-border/50">
              {notifications.map(notif => {
                const Icon = typeIcons[notif.type] || Bell;
                const color = typeColors[notif.type] || "text-muted-foreground";
                return (
                  <div
                    key={notif.id}
                    className={`flex items-start gap-3 p-3 hover:bg-accent/30 transition-colors cursor-pointer ${!notif.isRead ? "bg-primary/5" : ""}`}
                    onClick={() => {
                      if (!notif.isRead) markRead.mutate({ id: notif.id });
                      if (notif.relatedAdId) setLocation(`/ads/${notif.relatedAdId}`);
                    }}
                  >
                    <div className={`h-8 w-8 rounded-md flex items-center justify-center shrink-0 ${!notif.isRead ? "bg-primary/10" : "bg-muted"}`}>
                      <Icon className={`h-4 w-4 ${color}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className={`text-sm ${!notif.isRead ? "font-semibold" : ""}`}>{notif.title}</p>
                        {!notif.isRead && <div className="h-2 w-2 rounded-full bg-primary shrink-0" />}
                      </div>
                      {notif.message && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{notif.message}</p>}
                      <p className="text-[10px] text-muted-foreground mt-1">{new Date(notif.createdAt).toLocaleString()}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-12">
              <Bell className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No notifications yet.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
