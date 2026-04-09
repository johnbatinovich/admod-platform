import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Shield, Clock, AlertTriangle, ArrowRight, FileText, Bot, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { useLocation } from "wouter";

export default function ReviewQueue() {
  const [, setLocation] = useLocation();
  const { data: ads, isLoading } = trpc.ads.list.useQuery({});
  const { data: reviewStats } = trpc.reviews.stats.useQuery();

  const queues = useMemo(() => {
    if (!ads) return { submitted: [], inReview: [], escalated: [], changesRequested: [] };
    return {
      submitted: ads.filter(a => a.status === "submitted"),
      // Only show in_review ads that were routed here by the AI agent
      inReview: ads.filter(a => a.status === "in_review" && (a.aiAnalysis as any)?.routingDecision === "needs_review"),
      escalated: ads.filter(a => a.status === "escalated"),
      changesRequested: ads.filter(a => a.status === "changes_requested"),
    };
  }, [ads]);

  const totalPending = queues.submitted.length + queues.inReview.length + queues.escalated.length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Review Queue</h1>
        <p className="text-sm text-muted-foreground mt-1">Ads routed here by the AI agent for human review.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={Clock} label="Pending" value={totalPending} color="text-amber-600" />
        <StatCard icon={AlertTriangle} label="Escalated" value={queues.escalated.length} color="text-orange-600" />
        <StatCard icon={Shield} label="Reviews Today" value={reviewStats?.today ?? 0} color="text-primary" />
        <StatCard icon={FileText} label="Total Reviews" value={reviewStats?.total ?? 0} color="text-muted-foreground" />
      </div>

      <Tabs defaultValue="in_review">
        <TabsList className="bg-card border border-border">
          <TabsTrigger value="in_review" className="text-xs">
            In Review ({queues.inReview.length})
          </TabsTrigger>
          <TabsTrigger value="submitted" className="text-xs">
            Submitted ({queues.submitted.length})
          </TabsTrigger>
          <TabsTrigger value="escalated" className="text-xs">
            Escalated ({queues.escalated.length})
          </TabsTrigger>
          <TabsTrigger value="changes" className="text-xs">
            Changes Requested ({queues.changesRequested.length})
          </TabsTrigger>
        </TabsList>

        {/* In Review — AI-routed only, with moderator brief */}
        <TabsContent value="in_review">
          <Card className="bg-card border-border">
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-4 space-y-3">
                  {[1, 2, 3].map(i => <Skeleton key={i} className="h-24 w-full" />)}
                </div>
              ) : queues.inReview.length > 0 ? (
                <div className="divide-y divide-border/50">
                  {queues.inReview.map(ad => {
                    const ai = ad.aiAnalysis as any;
                    const step = (ad.currentApprovalStep ?? 0) + 1;
                    return (
                      <div
                        key={ad.id}
                        className="p-4 hover:bg-accent/50 cursor-pointer transition-colors"
                        onClick={() => setLocation(`/ads/${ad.id}`)}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3 min-w-0">
                            <PriorityDot priority={ad.priority} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm font-medium">{ad.title}</p>
                                <Badge variant="outline" className="text-[10px] bg-purple-50 text-purple-700 border-purple-200 h-4 px-1.5 shrink-0">
                                  <Bot className="h-2.5 w-2.5 mr-1" />
                                  AI-Routed
                                </Badge>
                                <Badge variant="outline" className="text-[10px] h-4 px-1.5 shrink-0">
                                  Step {step}
                                </Badge>
                              </div>
                              <p className="text-[11px] text-muted-foreground mt-0.5">
                                {ad.format} · {ad.priority} priority
                                {ai?.confidence !== undefined && ` · AI confidence: ${ai.confidence}%`}
                                {ad.aiScore !== null && ` · Score: ${ad.aiScore}/100`}
                              </p>
                              {ai?.moderatorBrief && (
                                <p className="text-[12px] text-muted-foreground mt-1.5 leading-relaxed line-clamp-2 bg-muted/40 rounded px-2 py-1">
                                  {ai.moderatorBrief}
                                </p>
                              )}
                              {ai?.routingReason && !ai?.moderatorBrief && (
                                <p className="text-[11px] text-muted-foreground/70 mt-1 italic line-clamp-1">
                                  {ai.routingReason}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {ad.aiScore !== null && (
                              <span className={`text-xs font-bold ${ad.aiScore >= 80 ? "text-green-600" : ad.aiScore >= 50 ? "text-amber-600" : "text-red-600"}`}>
                                {ad.aiScore}
                              </span>
                            )}
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-12">
                  <Bot className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground">No AI-routed ads awaiting review.</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Other tabs — simpler layout */}
        {(["submitted", "escalated", "changes"] as const).map(tab => {
          const items = tab === "submitted" ? queues.submitted :
            tab === "escalated" ? queues.escalated :
            queues.changesRequested;
          return (
            <TabsContent key={tab} value={tab}>
              <Card className="bg-card border-border">
                <CardContent className="p-0">
                  {isLoading ? (
                    <div className="p-4 space-y-3">
                      {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
                    </div>
                  ) : items.length > 0 ? (
                    <div className="divide-y divide-border/50">
                      {items.map(ad => (
                        <div
                          key={ad.id}
                          className="flex items-center justify-between p-3 hover:bg-accent/50 cursor-pointer transition-colors"
                          onClick={() => setLocation(`/ads/${ad.id}`)}
                        >
                          <div className="flex items-center gap-3">
                            <PriorityDot priority={ad.priority} />
                            <div>
                              <p className="text-sm font-medium">{ad.title}</p>
                              <p className="text-[11px] text-muted-foreground">
                                {ad.format} · {ad.priority} priority
                                {ad.aiScore !== null && ` · AI: ${ad.aiScore}/100`}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {ad.aiScore !== null && (
                              <span className={`text-xs font-bold ${ad.aiScore >= 80 ? "text-green-600" : ad.aiScore >= 50 ? "text-amber-600" : "text-red-600"}`}>
                                {ad.aiScore}
                              </span>
                            )}
                            <ArrowRight className="h-4 w-4 text-muted-foreground" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-12">
                      <Shield className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                      <p className="text-sm text-muted-foreground">No ads in this queue.</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: number; color: string }) {
  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <Icon className={`h-5 w-5 ${color}`} />
          <div>
            <p className="text-xl font-bold">{value}</p>
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PriorityDot({ priority }: { priority: string }) {
  const colors: Record<string, string> = {
    low: "bg-muted-foreground", normal: "bg-blue-500", high: "bg-orange-500", urgent: "bg-red-500",
  };
  return <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${colors[priority] || "bg-muted-foreground"}`} />;
}
