import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  FileText, CheckCircle, XCircle, AlertTriangle, BarChart3,
  ArrowRight, Bot, Shield, Clock, TrendingUp, Sparkles, Loader2, Zap
} from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

export default function Home() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [showDemoDialog, setShowDemoDialog] = useState(false);
  const utils = trpc.useUtils();
  const { data: stats, isLoading } = trpc.dashboard.stats.useQuery();
  const { data: adCounts } = trpc.dashboard.adCounts.useQuery();
  const { data: recentActivity } = trpc.dashboard.recentActivity.useQuery();
  const { data: agentActivity } = trpc.dashboard.agentActivity.useQuery();
  const { data: autoStats } = trpc.dashboard.autoStats.useQuery();

  const seedDemo = trpc.ads.seedDemoData.useMutation({
    onSuccess: (data) => {
      setShowDemoDialog(false);
      utils.dashboard.stats.invalidate();
      utils.dashboard.adCounts.invalidate();
      utils.dashboard.recentActivity.invalidate();
      utils.dashboard.agentActivity.invalidate();
      utils.dashboard.autoStats.invalidate();
      toast.success(`Demo data loaded — ${data.count} sample ads created`);
    },
    onError: (e) => toast.error(`Failed to load demo data: ${e.message}`),
  });

  const isAdmin = (user as any)?.platformRole === "admin" || (user as any)?.role === "admin";

  const statCards = [
    { label: "Total Ads", value: stats?.totalAds ?? 0, icon: FileText, color: "text-primary" },
    { label: "Pending Review", value: stats?.pendingReview ?? 0, icon: Clock, color: "text-warning" },
    { label: "Approved", value: stats?.approved ?? 0, icon: CheckCircle, color: "text-success" },
    { label: "Rejected", value: stats?.rejected ?? 0, icon: XCircle, color: "text-destructive" },
    { label: "Open Violations", value: stats?.violations ?? 0, icon: AlertTriangle, color: "text-warning" },
    { label: "Avg AI Score", value: stats?.avgAiScore ?? 0, icon: Bot, color: "text-primary" },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Welcome back, {user?.name || "User"}. Here's your moderation overview.
          </p>
        </div>
        <div className="flex gap-2">
          {isAdmin && (
            <Button variant="outline" size="sm" onClick={() => setShowDemoDialog(true)}>
              <Sparkles className="h-4 w-4 mr-1.5" />
              Load Demo Data
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setLocation("/review")}>
            <Shield className="h-4 w-4 mr-1.5" />
            Review Queue
          </Button>
          <Button size="sm" onClick={() => setLocation("/ads/new")}>
            <FileText className="h-4 w-4 mr-1.5" />
            Submit Ad
          </Button>
        </div>

        <Dialog open={showDemoDialog} onOpenChange={setShowDemoDialog}>
          <DialogContent className="bg-card max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                Load Demo Data
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground leading-relaxed">
                This will populate the platform with <strong>8 sample ads</strong> in various states — approved, in review, and rejected — along with realistic AI analysis results, policy violations, and approval chain progress.
              </p>
              <div className="rounded-lg bg-muted/50 border border-border p-3 text-xs space-y-1 text-muted-foreground">
                <p>• Summer Beach Getaway — auto-approved, score 95</p>
                <p>• Bud Light Game Day — in review (alcohol age-gating)</p>
                <p>• Pfizer Xeljanz DTC — in review (fair balance)</p>
                <p>• DraftKings Bonus Offer — rejected (blocking violations)</p>
                <p>• Toyota RAV4 Adventure — auto-approved, score 97</p>
                <p>• Campaign for Change PAC — in review (disclosure)</p>
                <p>• Juul Vaping Lifestyle — auto-rejected (tobacco ban)</p>
                <p>• Disney+ Streaming Promo — pending analysis</p>
              </div>
              <p className="text-xs text-muted-foreground">Compliance policy templates and the default approval chain will also be seeded if not already present.</p>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={() => setShowDemoDialog(false)}>Cancel</Button>
                <Button size="sm" onClick={() => seedDemo.mutate()} disabled={seedDemo.isPending}>
                  {seedDemo.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Sparkles className="h-4 w-4 mr-1.5" />}
                  Load Demo Data
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {statCards.map((stat) => (
          <Card key={stat.label} className="bg-card border-border">
            <CardContent className="p-4">
              {isLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <stat.icon className={`h-4 w-4 ${stat.color}`} />
                  </div>
                  <div>
                    <p className="text-2xl font-bold">{stat.value}</p>
                    <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider">{stat.label}</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Agent Automation Stats */}
      <Card className="bg-card border-border border-purple-200">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <div className="h-6 w-6 rounded bg-purple-50 flex items-center justify-center">
              <Zap className="h-3.5 w-3.5 text-purple-700" />
            </div>
            <span className="text-sm font-semibold">AI Agent — Last 7 Days</span>
            <span className="text-[11px] text-muted-foreground ml-1">automation summary</span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg bg-green-50 border border-green-200 p-3 text-center">
              <p className="text-2xl font-bold" style={{ color: "#15803d" }}>{autoStats?.autoApproved ?? 0}</p>
              <p className="text-[11px] font-semibold uppercase tracking-wider mt-0.5" style={{ color: "#374151" }}>Auto-Approved</p>
            </div>
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-center">
              <p className="text-2xl font-bold" style={{ color: "#b45309" }}>{autoStats?.flaggedForReview ?? 0}</p>
              <p className="text-[11px] font-semibold uppercase tracking-wider mt-0.5" style={{ color: "#374151" }}>Flagged for Review</p>
            </div>
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-center">
              <p className="text-2xl font-bold" style={{ color: "#b91c1c" }}>{autoStats?.autoRejected ?? 0}</p>
              <p className="text-[11px] font-semibold uppercase tracking-wider mt-0.5" style={{ color: "#374151" }}>Auto-Rejected</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Main Content Grid */}
      <div className="grid lg:grid-cols-3 gap-4">
        {/* Status Breakdown */}
        <Card className="lg:col-span-2 bg-card border-border">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold">Ad Status Breakdown</CardTitle>
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => setLocation("/ads")}>
                View All <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {adCounts ? (
              <div className="space-y-3">
                {Object.entries(adCounts).map(([status, count]) => (
                  <div key={status} className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <StatusDot status={status} />
                      <span className="text-sm capitalize">{status.replace(/_/g, " ")}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="w-32 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-primary transition-all"
                          style={{ width: `${Math.min(100, ((count as number) / Math.max(stats?.totalAds ?? 1, 1)) * 100)}%` }}
                        />
                      </div>
                      <span className="text-sm font-medium w-8 text-right">{count as number}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-6 w-full" />)}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Quick Actions */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold">Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <QuickAction icon={FileText} label="Submit New Ad" description="Upload and submit ad content" onClick={() => setLocation("/ads/new")} />
            <QuickAction icon={Shield} label="Review Queue" description="Review pending submissions" onClick={() => setLocation("/review")} />
            <QuickAction icon={Bot} label="AI Screening" description="Run automated AI analysis" onClick={() => setLocation("/ai-screening")} />
            <QuickAction icon={AlertTriangle} label="Violations" description="Manage policy violations" onClick={() => setLocation("/violations")} />
            <QuickAction icon={BarChart3} label="Analytics" description="View moderation metrics" onClick={() => setLocation("/analytics")} />
            <QuickAction icon={TrendingUp} label="Policies" description="Manage compliance policies" onClick={() => setLocation("/policies")} />
          </CardContent>
        </Card>
      </div>

      {/* Agent Activity Feed */}
      {agentActivity && agentActivity.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-5 w-5 rounded bg-purple-50 flex items-center justify-center">
                  <Bot className="h-3 w-3 text-purple-700" />
                </div>
                <CardTitle className="text-sm font-semibold">Agent Activity Feed</CardTitle>
              </div>
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => setLocation("/audit")}>
                View All <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {agentActivity.map((entry) => {
                const d = entry.details as any;
                const decision = d?.routingDecision as string | undefined;
                const clearance = d?.clearanceScore as number | undefined;
                const confidence = d?.routingConfidence as number | undefined;
                const decisionStyle =
                  decision === "auto_approve" ? { badge: "bg-green-500/15 text-green-600 border-green-300", label: "Auto-Approved" } :
                  decision === "auto_reject"  ? { badge: "bg-red-500/15 text-red-600 border-red-300", label: "Auto-Rejected" } :
                                                { badge: "bg-yellow-500/15 text-amber-600 border-amber-300", label: "Flagged for Review" };
                return (
                  <div key={entry.id} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                    <div className="flex items-center gap-3">
                      <div className="h-7 w-7 rounded-md bg-purple-50 flex items-center justify-center shrink-0">
                        <Zap className="h-3.5 w-3.5 text-purple-700" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm truncate max-w-[220px]">{entry.adTitle ?? `Ad #${entry.entityId}`}</p>
                        {d?.routingReason && (
                          <p className="text-[11px] text-muted-foreground truncate max-w-[220px]">{d.routingReason}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {clearance !== undefined && (
                        <span className={`text-sm font-bold tabular-nums ${
                          clearance >= 80 ? "text-green-600" : clearance >= 50 ? "text-amber-600" : "text-red-600"
                        }`}>{clearance}</span>
                      )}
                      {clearance === undefined && confidence !== undefined && (
                        <span className="text-[11px] text-muted-foreground">{confidence}%</span>
                      )}
                      {decision && (
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${decisionStyle.badge}`}>
                          {decisionStyle.label}
                        </span>
                      )}
                      <span className="text-[11px] text-muted-foreground">
                        {new Date(entry.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Activity */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold">Recent Activity</CardTitle>
            <Button variant="ghost" size="sm" className="text-xs" onClick={() => setLocation("/audit")}>
              View All <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {recentActivity && recentActivity.length > 0 ? (
            <div className="space-y-2">
              {recentActivity.slice(0, 8).map((entry) => (
                <div key={entry.id} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                  <div className="flex items-center gap-3">
                    <div className="h-7 w-7 rounded-md bg-primary/10 flex items-center justify-center">
                      <ActionIcon action={entry.action} />
                    </div>
                    <div>
                      <p className="text-sm">{formatAction(entry.action)}</p>
                      <p className="text-[11px] text-muted-foreground">{entry.entityType} #{entry.entityId}</p>
                    </div>
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8">No recent activity. Submit an ad to get started.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function QuickAction({ icon: Icon, label, description, onClick }: {
  icon: any; label: string; description: string; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 p-2.5 rounded-md hover:bg-accent transition-colors text-left"
    >
      <div className="h-8 w-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-[11px] text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: "bg-muted-foreground",
    submitted: "bg-blue-500",
    ai_screening: "bg-purple-500",
    in_review: "bg-yellow-500",
    escalated: "bg-orange-500",
    changes_requested: "bg-amber-500",
    approved: "bg-green-500",
    rejected: "bg-red-500",
    published: "bg-emerald-500",
    archived: "bg-gray-500",
  };
  return <div className={`h-2 w-2 rounded-full ${colors[status] || "bg-muted-foreground"}`} />;
}

function ActionIcon({ action }: { action: string }) {
  if (action.includes("create") || action.includes("submit")) return <FileText className="h-3.5 w-3.5 text-primary" />;
  if (action.includes("review")) return <CheckCircle className="h-3.5 w-3.5 text-success" />;
  if (action.includes("reject")) return <XCircle className="h-3.5 w-3.5 text-destructive" />;
  if (action.includes("ai")) return <Bot className="h-3.5 w-3.5 text-purple-700" />;
  return <Shield className="h-3.5 w-3.5 text-muted-foreground" />;
}

function formatAction(action: string) {
  return action.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
