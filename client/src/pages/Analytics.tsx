import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart3, TrendingUp, Clock, CheckCircle, XCircle, Bot, AlertTriangle, Shield } from "lucide-react";

export default function Analytics() {
  const { data: stats, isLoading } = trpc.dashboard.stats.useQuery();
  const { data: adCounts } = trpc.dashboard.adCounts.useQuery();
  const { data: reviewStats } = trpc.reviews.stats.useQuery();
  const { data: violationStats } = trpc.violations.stats.useQuery();

  const totalAds = stats?.totalAds ?? 0;
  const approvalRate = totalAds > 0 ? Math.round(((stats?.approved ?? 0) / totalAds) * 100) : 0;
  const rejectionRate = totalAds > 0 ? Math.round(((stats?.rejected ?? 0) / totalAds) * 100) : 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Analytics</h1>
        <p className="text-sm text-muted-foreground mt-1">Moderation metrics, SLA tracking, and performance analytics.</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPICard icon={BarChart3} label="Total Ads" value={totalAds} color="text-primary" loading={isLoading} />
        <KPICard icon={CheckCircle} label="Approval Rate" value={`${approvalRate}%`} color="text-success" loading={isLoading} />
        <KPICard icon={XCircle} label="Rejection Rate" value={`${rejectionRate}%`} color="text-destructive" loading={isLoading} />
        <KPICard icon={Bot} label="Avg AI Score" value={stats?.avgAiScore ?? 0} color="text-primary" loading={isLoading} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Status Distribution */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Status Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            {adCounts ? (
              <div className="space-y-3">
                {Object.entries(adCounts).map(([status, count]) => {
                  const pct = totalAds > 0 ? ((count as number) / totalAds) * 100 : 0;
                  return (
                    <div key={status} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="capitalize">{status.replace(/_/g, " ")}</span>
                        <span className="font-medium">{count as number} ({pct.toFixed(1)}%)</span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
            )}
          </CardContent>
        </Card>

        {/* Review Performance */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Review Performance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <MetricRow icon={Shield} label="Total Reviews" value={reviewStats?.total ?? 0} />
              <MetricRow icon={Clock} label="Reviews Today" value={reviewStats?.today ?? 0} />
              <MetricRow icon={AlertTriangle} label="Total Violations" value={violationStats?.total ?? 0} />
              <MetricRow icon={XCircle} label="Open Violations" value={violationStats?.open ?? 0} />
              <MetricRow icon={CheckCircle} label="Resolved Violations" value={(violationStats?.total ?? 0) - (violationStats?.open ?? 0)} />
              <MetricRow icon={TrendingUp} label="Pending Review" value={stats?.pendingReview ?? 0} />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Moderation SLA */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Moderation SLA Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <SLACard label="Urgent Priority" target="< 2 hours" current={stats?.pendingReview ?? 0} />
            <SLACard label="High Priority" target="< 4 hours" current={0} />
            <SLACard label="Normal Priority" target="< 24 hours" current={0} />
            <SLACard label="Low Priority" target="< 48 hours" current={0} />
          </div>
          <p className="text-[11px] text-muted-foreground mt-3">SLA tracking is based on submission time to first review decision. Detailed SLA metrics will populate as more ads are processed.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function KPICard({ icon: Icon, label, value, color, loading }: { icon: any; label: string; value: any; color: string; loading: boolean }) {
  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4">
        {loading ? <Skeleton className="h-16 w-full" /> : (
          <div className="space-y-2">
            <Icon className={`h-5 w-5 ${color}`} />
            <div>
              <p className="text-2xl font-bold">{value}</p>
              <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MetricRow({ icon: Icon, label, value }: { icon: any; label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm">{label}</span>
      </div>
      <span className="text-sm font-bold">{value}</span>
    </div>
  );
}

function SLACard({ label, target, current }: { label: string; target: string; current: number }) {
  return (
    <div className="p-3 rounded-lg bg-background border border-border/50 text-center">
      <p className="text-xs font-medium">{label}</p>
      <p className="text-lg font-bold text-primary mt-1">{target}</p>
      <p className="text-[11px] text-muted-foreground">{current} pending</p>
    </div>
  );
}
