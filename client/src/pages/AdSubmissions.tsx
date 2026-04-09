import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, Search, Filter, Image, Video, Music, Type, Plus, Box, Youtube, Link2, Bot, Clock } from "lucide-react";
import { useState, useMemo } from "react";
import { useLocation } from "wouter";

const statusColors: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  submitted: "bg-blue-50 text-blue-600 border-blue-200",
  ai_screening: "bg-purple-50 text-purple-700 border-purple-200",
  ai_failed: "bg-red-500/15 text-red-400 border-red-500/30",
  in_review: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  escalated: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  changes_requested: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  approved: "bg-green-500/15 text-green-400 border-green-500/30",
  rejected: "bg-red-500/15 text-red-400 border-red-500/30",
  published: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  archived: "bg-gray-500/15 text-gray-400 border-gray-500/30",
};

const formatIcons: Record<string, any> = {
  video: Video, image: Image, audio: Music, text: Type, rich_media: Box,
};

export default function AdSubmissions() {
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [formatFilter, setFormatFilter] = useState("all");
  const [aiDecisionFilter, setAiDecisionFilter] = useState("all");

  const filters = useMemo(() => ({
    search: search || undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
    format: formatFilter !== "all" ? formatFilter : undefined,
  }), [search, statusFilter, formatFilter]);

  const { data: rawAds, isLoading } = trpc.ads.list.useQuery(filters);

  const ads = useMemo(() => {
    if (!rawAds || aiDecisionFilter === "all") return rawAds;
    return rawAds.filter(ad => {
      const decision = (ad.aiAnalysis as any)?.routingDecision;
      if (aiDecisionFilter === "auto_approve") return decision === "auto_approve";
      if (aiDecisionFilter === "auto_reject") return decision === "auto_reject";
      if (aiDecisionFilter === "needs_review") return decision === "needs_review";
      if (aiDecisionFilter === "pending") return !decision;
      return true;
    });
  }, [rawAds, aiDecisionFilter]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Ad Submissions</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage and track all advertising submissions.</p>
        </div>
        <Button size="sm" onClick={() => setLocation("/ads/new")}>
          <Plus className="h-4 w-4 mr-1.5" />
          Submit Ad
        </Button>
      </div>

      {/* Filters */}
      <Card className="bg-card border-border">
        <CardContent className="p-3">
          <div className="flex flex-wrap gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search ads..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-8 h-9 text-sm bg-background"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[160px] h-9 text-sm bg-background">
                <Filter className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="submitted">Submitted</SelectItem>
                <SelectItem value="ai_screening">AI Screening</SelectItem>
                <SelectItem value="in_review">In Review</SelectItem>
                <SelectItem value="escalated">Escalated</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
            <Select value={formatFilter} onValueChange={setFormatFilter}>
              <SelectTrigger className="w-[140px] h-9 text-sm bg-background">
                <SelectValue placeholder="Format" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Formats</SelectItem>
                <SelectItem value="video">Video</SelectItem>
                <SelectItem value="image">Image</SelectItem>
                <SelectItem value="audio">Audio</SelectItem>
                <SelectItem value="text">Text</SelectItem>
                <SelectItem value="rich_media">Rich Media</SelectItem>
              </SelectContent>
            </Select>
            <Select value={aiDecisionFilter} onValueChange={setAiDecisionFilter}>
              <SelectTrigger className="w-[155px] h-9 text-sm bg-background">
                <Bot className="h-3.5 w-3.5 mr-1.5 text-purple-700" />
                <SelectValue placeholder="AI Decision" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All AI Decisions</SelectItem>
                <SelectItem value="auto_approve">Auto-Approved</SelectItem>
                <SelectItem value="needs_review">Routed to Review</SelectItem>
                <SelectItem value="auto_reject">Auto-Rejected</SelectItem>
                <SelectItem value="pending">Pending AI</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Ads Table */}
      <Card className="bg-card border-border">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : ads && ads.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground p-3">Ad</th>
                    <th className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground p-3">Format</th>
                    <th className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground p-3">Status</th>
                    <th className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground p-3">Priority</th>
                    <th className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground p-3">Clearance</th>
                    <th className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground p-3">Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {ads.map(ad => {
                    const FormatIcon = formatIcons[ad.format] || FileText;
                    return (
                      <tr
                        key={ad.id}
                        className="border-b border-border/50 hover:bg-accent/50 cursor-pointer transition-colors"
                        onClick={() => setLocation(`/ads/${ad.id}`)}
                      >
                        <td className="p-3">
                          <div className="flex items-center gap-3">
                            <div className="relative">
                              <div className="h-8 w-8 rounded bg-primary/10 flex items-center justify-center shrink-0">
                                <FormatIcon className="h-4 w-4 text-primary" />
                              </div>
                              {(ad.aiAnalysis as any)?.routingDecision ? (
                                <div className="absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full bg-purple-500/20 border border-background flex items-center justify-center">
                                  <Bot className="h-2 w-2 text-purple-700" />
                                </div>
                              ) : (ad.status === "submitted" || ad.status === "draft") ? (
                                <div className="absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full bg-muted border border-background flex items-center justify-center">
                                  <Clock className="h-2 w-2 text-muted-foreground" />
                                </div>
                              ) : null}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-medium truncate max-w-[250px]">{ad.title}</p>
                              {ad.description && <p className="text-[11px] text-muted-foreground truncate max-w-[250px]">{ad.description}</p>}
                            </div>
                          </div>
                        </td>
                        <td className="p-3">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs capitalize">{ad.format.replace("_", " ")}</span>
                            {ad.sourceType === "youtube" && (
                              <Youtube className="h-3.5 w-3.5 text-red-500" />
                            )}
                            {ad.sourceType === "vimeo" && (
                              <Video className="h-3.5 w-3.5 text-blue-600" />
                            )}
                            {ad.sourceType === "direct_url" && (
                              <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                          </div>
                        </td>
                        <td className="p-3">
                          <Badge variant="outline" className={`text-[11px] ${statusColors[ad.status] || ""}`}>
                            {ad.status.replace(/_/g, " ")}
                          </Badge>
                        </td>
                        <td className="p-3">
                          <PriorityBadge priority={ad.priority} />
                        </td>
                        <td className="p-3">
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-1.5">
                              {ad.aiScore !== null ? (
                                <ScoreBadge score={ad.aiScore} />
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                              {(ad.aiAnalysis as any)?.confidence !== undefined && (
                                <span className="text-[10px] text-muted-foreground">({(ad.aiAnalysis as any).confidence}%)</span>
                              )}
                            </div>
                            {(ad.aiAnalysis as any)?.routingDecision && (
                              <RoutingBadge decision={(ad.aiAnalysis as any).routingDecision} />
                            )}
                          </div>
                        </td>
                        <td className="p-3">
                          <span className="text-xs text-muted-foreground">
                            {ad.submittedAt ? new Date(ad.submittedAt).toLocaleDateString() : "—"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-12">
              <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No ads found. Submit your first ad to get started.</p>
              <Button size="sm" className="mt-3" onClick={() => setLocation("/ads/new")}>Submit Ad</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const colors: Record<string, string> = {
    low: "text-muted-foreground",
    normal: "text-blue-600",
    high: "text-orange-400",
    urgent: "text-red-400",
  };
  return <span className={`text-xs font-medium capitalize ${colors[priority] || ""}`}>{priority}</span>;
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 80 ? "text-green-400" : score >= 50 ? "text-yellow-400" : "text-red-400";
  return <span className={`text-xs font-bold ${color}`}>{score}/100</span>;
}

function RoutingBadge({ decision }: { decision: string }) {
  const styles: Record<string, string> = {
    auto_approve: "text-green-400",
    auto_reject: "text-red-400",
    needs_review: "text-yellow-400",
  };
  const labels: Record<string, string> = {
    auto_approve: "auto approved",
    auto_reject: "auto rejected",
    needs_review: "human review",
  };
  return (
    <span className={`text-[10px] font-medium ${styles[decision] ?? "text-muted-foreground"}`}>
      {labels[decision] ?? decision.replace(/_/g, " ")}
    </span>
  );
}
