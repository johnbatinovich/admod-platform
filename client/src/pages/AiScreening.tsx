import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Bot, Play, CheckCircle, Loader2, ArrowRight, Megaphone, AlertTriangle, Languages, Building2, Ban } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

export default function AiScreening() {
  const [, setLocation] = useLocation();
  const { data: ads, isLoading } = trpc.ads.list.useQuery({});
  const utils = trpc.useUtils();
  const [runningId, setRunningId] = useState<number | null>(null);

  const runAi = trpc.ads.runAiScreening.useMutation({
    onSuccess: () => {
      utils.ads.list.invalidate();
      toast.success("AI screening complete");
      setRunningId(null);
    },
    onError: (e) => {
      toast.error(e.message);
      setRunningId(null);
    },
  });

  const screenableAds = useMemo(() => {
    if (!ads) return [];
    return ads.filter(a => ["submitted", "in_review"].includes(a.status));
  }, [ads]);

  const screenedAds = useMemo(() => {
    if (!ads) return [];
    return ads.filter(a => a.aiScore !== null);
  }, [ads]);

  const handleRunScreening = (adId: number) => {
    setRunningId(adId);
    runAi.mutate({ adId });
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">AI Screening</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Run automated AI analysis on ad submissions for content compliance, brand safety, and policy violations.
        </p>
      </div>

      {/* Pending Screening */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Bot className="h-4 w-4 text-primary" />
            Ready for Screening ({screenableAds.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : screenableAds.length > 0 ? (
            <div className="space-y-2">
              {screenableAds.map(ad => (
                <div key={ad.id} className="flex items-center justify-between p-3 rounded-lg bg-background border border-border/50">
                  <div className="flex items-center gap-3 cursor-pointer" onClick={() => setLocation(`/ads/${ad.id}`)}>
                    <div className="h-8 w-8 rounded bg-primary/10 flex items-center justify-center">
                      <Bot className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{ad.title}</p>
                      <p className="text-[11px] text-muted-foreground">{ad.format} · {ad.status.replace(/_/g, " ")}</p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleRunScreening(ad.id)}
                    disabled={runningId === ad.id}
                  >
                    {runningId === ad.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                    ) : (
                      <Play className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    {runningId === ad.id ? "Analyzing..." : "Run AI"}
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8">No ads pending screening.</p>
          )}
        </CardContent>
      </Card>

      {/* Screened Ads */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-success" />
            Previously Screened ({screenedAds.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {screenedAds.length > 0 ? (
            <div className="space-y-2">
              {screenedAds.slice(0, 10).map(ad => {
                const analysis = ad.aiAnalysis as any;
                const langs = analysis?.detectedLanguages ?? [];
                const blocked = analysis?.audienceDemographics?.blockedAudiences ?? [];
                const objContent = analysis?.objectionalContent ?? [];
                const advertiser = analysis?.detectedAdvertiser;
                return (
                  <div
                    key={ad.id}
                    className="p-3 rounded-lg bg-background border border-border/50 cursor-pointer hover:bg-accent/50 transition-colors"
                    onClick={() => setLocation(`/ads/${ad.id}`)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <ScoreBadge score={ad.aiScore!} />
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium">{ad.title}</p>
                            {analysis?.isPoliticalAd && (
                              <Badge className="text-[9px] bg-orange-100 text-orange-600 border-orange-300 py-0 px-1.5 h-4">
                                <Megaphone className="h-2.5 w-2.5 mr-0.5" />Political
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <p className="text-[11px] text-muted-foreground">
                              {analysis?.recommendation?.replace(/_/g, " ") || "analyzed"} · FCC {analysis?.overallFccScore ?? "—"} · IAB {analysis?.overallIabScore ?? "—"}
                            </p>
                          </div>
                        </div>
                      </div>
                      <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    </div>

                    {/* Signal badges row */}
                    {(advertiser?.name || langs.length > 0 || objContent.length > 0 || blocked.length > 0) && (
                      <div className="flex flex-wrap items-center gap-1.5 mt-2 ml-13 pl-[52px]">
                        {advertiser?.name && (
                          <Badge variant="outline" className="text-[9px] border-muted-foreground/30 py-0 h-4 gap-0.5">
                            <Building2 className="h-2.5 w-2.5" />{advertiser.name}
                          </Badge>
                        )}
                        {langs.slice(0, 2).map((l: any, i: number) => (
                          <Badge key={i} variant="outline" className="text-[9px] border-muted-foreground/30 py-0 h-4 gap-0.5">
                            <Languages className="h-2.5 w-2.5" />{l.language}
                          </Badge>
                        ))}
                        {objContent.slice(0, 2).map((oc: any, i: number) => (
                          <Badge key={i} variant="outline" className="text-[9px] border-amber-300 text-amber-600 py-0 h-4 gap-0.5">
                            <AlertTriangle className="h-2.5 w-2.5" />{oc.type.replace(/_/g, " ")}
                          </Badge>
                        ))}
                        {blocked.filter((b: any) => b.severity === "legal").length > 0 && (
                          <Badge variant="outline" className="text-[9px] border-red-300 text-red-600 py-0 h-4 gap-0.5">
                            <Ban className="h-2.5 w-2.5" />{blocked.filter((b: any) => b.severity === "legal").length} legal block{blocked.filter((b: any) => b.severity === "legal").length !== 1 ? "s" : ""}
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8">No ads have been screened yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 80 ? "bg-green-100 text-green-600" : score >= 50 ? "bg-amber-100 text-amber-600" : "bg-red-100 text-red-600";
  return (
    <div className={`h-10 w-10 rounded-lg flex items-center justify-center text-sm font-bold ${color}`}>
      {score}
    </div>
  );
}
