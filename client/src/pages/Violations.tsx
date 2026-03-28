import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, CheckCircle, XCircle, Shield } from "lucide-react";
import { useLocation } from "wouter";

export default function Violations() {
  const [, setLocation] = useLocation();
  const { data: stats } = trpc.violations.stats.useQuery();
  const { data: ads, isLoading } = trpc.ads.list.useQuery({});

  // Get ads that have violations (AI score < 80 or status indicates issues)
  const adsWithIssues = ads?.filter(a => a.aiScore !== null && a.aiScore < 80) || [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Violations</h1>
        <p className="text-sm text-muted-foreground mt-1">Track and manage policy violations across all ad submissions.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              <div>
                <p className="text-xl font-bold">{stats?.total ?? 0}</p>
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider">Total Violations</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <XCircle className="h-5 w-5 text-warning" />
              <div>
                <p className="text-xl font-bold">{stats?.open ?? 0}</p>
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider">Open</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <CheckCircle className="h-5 w-5 text-success" />
              <div>
                <p className="text-xl font-bold">{(stats?.total ?? 0) - (stats?.open ?? 0)}</p>
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider">Resolved</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Ads with Violations</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : adsWithIssues.length > 0 ? (
            <div className="space-y-2">
              {adsWithIssues.map(ad => (
                <div
                  key={ad.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-background border border-border/50 cursor-pointer hover:bg-accent/50 transition-colors"
                  onClick={() => setLocation(`/ads/${ad.id}`)}
                >
                  <div className="flex items-center gap-3">
                    <div className={`h-8 w-8 rounded flex items-center justify-center text-xs font-bold ${
                      (ad.aiScore ?? 0) < 50 ? "bg-red-500/20 text-red-400" : "bg-yellow-500/20 text-yellow-400"
                    }`}>
                      {ad.aiScore}
                    </div>
                    <div>
                      <p className="text-sm font-medium">{ad.title}</p>
                      <p className="text-[11px] text-muted-foreground">{ad.format} · {ad.status.replace(/_/g, " ")}</p>
                    </div>
                  </div>
                  <Badge variant={ad.status === "rejected" ? "destructive" : "secondary"} className="text-[10px]">
                    {ad.status.replace(/_/g, " ")}
                  </Badge>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <Shield className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No violations found. Run AI screening on ads to detect violations.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
