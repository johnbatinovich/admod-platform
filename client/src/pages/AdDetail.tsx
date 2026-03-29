import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Progress } from "@/components/ui/progress";
import {
  ArrowLeft, Bot, CheckCircle, XCircle, AlertTriangle, MessageSquare,
  Shield, Clock, FileText, Image, Video, Music, Type, Loader2, ExternalLink,
  Youtube, Link2, Film, Play, Eye, TriangleAlert, CircleCheck, Info,
  Globe, Languages, Flag, Users, Ban, Building2, Megaphone, Zap
} from "lucide-react";
import { useState, useMemo } from "react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";

export default function AdDetail() {
  const params = useParams<{ id: string }>();
  const adId = parseInt(params.id || "0");
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const utils = trpc.useUtils();

  // Poll while AI review is running (status=ai_screening) or frame analysis is extracting
  const { data: ad, isLoading } = trpc.ads.getById.useQuery(
    { id: adId },
    { refetchInterval: (data: any) => data?.status === "ai_screening" ? 2500 : false }
  );
  const { data: frameAnalysis, isLoading: frameLoading } = trpc.ads.getFrameAnalysis.useQuery(
    { adId },
    { refetchInterval: (data: any) => data?.status === "running" ? 2500 : false }
  );
  // For uploaded files, get a presigned URL so the browser can load them from private R2 storage
  const { data: signedUrlData } = trpc.ads.getSignedUrl.useQuery(
    { fileKey: ad?.fileKey ?? "" },
    { enabled: !!(ad?.fileKey && ad?.sourceType === "upload"), staleTime: 50 * 60 * 1000 }
  );
  const playableUrl = ((ad?.sourceType === "upload" && signedUrlData?.url) ? signedUrlData.url : ad?.fileUrl) ?? undefined;

  const runAiReview = trpc.ads.runAiReview.useMutation({
    onSuccess: () => {
      utils.ads.getById.invalidate({ id: adId });
      utils.ads.getFrameAnalysis.invalidate({ adId });
      toast.info("AI Review started — results will appear automatically");
    },
    onError: (e) => toast.error(`AI Review failed: ${e.message}`),
  });
  const submitReview = trpc.reviews.submit.useMutation({
    onSuccess: () => { utils.ads.getById.invalidate({ id: adId }); toast.success("Review submitted"); },
    onError: (e) => toast.error(e.message),
  });
  const resolveViolation = trpc.violations.resolve.useMutation({
    onSuccess: () => { utils.ads.getById.invalidate({ id: adId }); toast.success("Violation updated"); },
  });

  const [reviewComment, setReviewComment] = useState("");
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!ad) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Ad not found.</p>
        <Button variant="outline" className="mt-3" onClick={() => setLocation("/ads")}>Back to Ads</Button>
      </div>
    );
  }

  const aiAnalysis = ad.aiAnalysis as any;
  const aiAnalysisError = aiAnalysis?.error === true ? (aiAnalysis.errorMessage as string | undefined) : null;
  const reviewStage: string | undefined = ad.status === "ai_screening" ? aiAnalysis?.reviewStage : undefined;
  const FormatIcon = { video: Video, image: Image, audio: Music, text: Type, rich_media: FileText }[ad.format] || FileText;

  const handleReview = (decision: "approve" | "reject" | "request_changes" | "escalate") => {
    submitReview.mutate({ adSubmissionId: adId, decision, comments: reviewComment });
    setReviewComment("");
  };

  const isExternalVideo = ad.sourceType === "youtube" || ad.sourceType === "vimeo" || ad.sourceType === "direct_url";
  const hasEmbed = !!(ad as any).embedUrl;
  const providerLabel = (ad as any).videoProvider === "youtube" ? "YouTube"
    : (ad as any).videoProvider === "vimeo" ? "Vimeo"
    : (ad as any).sourceType === "direct_url" ? "Direct URL"
    : null;

  const canRunFrameAnalysis = ad.format === "video" || ad.format === "image" || isExternalVideo;

  // Parse frame analysis data
  const frames = (frameAnalysis?.frames as any[] || []);
  const flaggedFrames = frames.filter((f: any) => f.severity !== "safe" && f.issues?.length > 0);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/ads")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight">{ad.title}</h1>
            <StatusBadge status={ad.status} />
            {providerLabel && (
              <Badge className={`text-[10px] ${
                (ad as any).videoProvider === "youtube" ? "bg-red-600 hover:bg-red-700 text-white" :
                (ad as any).videoProvider === "vimeo" ? "bg-blue-500 hover:bg-blue-600 text-white" :
                "bg-muted"
              }`}>
                {providerLabel}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            ID: #{ad.id} · {ad.format.replace("_", " ")} · Priority: {ad.priority}
            {(ad as any).videoDuration ? ` · Duration: ${(ad as any).videoDuration}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {reviewStage && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground border border-border rounded-md px-2.5 py-1.5 bg-background">
              <Loader2 className="h-3 w-3 animate-spin text-primary" />
              {reviewStage === "stage1_running" && "Stage 1: Scanning…"}
              {reviewStage === "stage2_running" && "Stage 2: Deep analysis…"}
              {reviewStage === "stage3_running" && "Stage 3: Generating report…"}
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => runAiReview.mutate({ adId })}
            disabled={runAiReview.isPending || ad.status === "ai_screening"}
          >
            {ad.status === "ai_screening" || runAiReview.isPending
              ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              : <Zap className="h-4 w-4 mr-1.5" />}
            Run AI Review
          </Button>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-4">
          <Tabs defaultValue="details">
            <TabsList className="bg-card border border-border">
              <TabsTrigger value="details" className="text-xs">Details</TabsTrigger>
              <TabsTrigger value="frames" className="text-xs">
                <Film className="h-3 w-3 mr-1" />
                Frames {frameAnalysis ? `(${frames.length})` : ""}
              </TabsTrigger>
              <TabsTrigger value="ai" className="text-xs">AI Analysis</TabsTrigger>
              <TabsTrigger value="reviews" className="text-xs">Reviews ({ad.reviews?.length || 0})</TabsTrigger>
              <TabsTrigger value="violations" className="text-xs">Violations ({ad.violations?.length || 0})</TabsTrigger>
              <TabsTrigger value="approval" className="text-xs">Approval</TabsTrigger>
            </TabsList>

            {/* Details Tab */}
            <TabsContent value="details">
              <Card className="bg-card border-border">
                <CardContent className="p-4 space-y-4">
                  {ad.description && (
                    <div>
                      <label className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Description</label>
                      <p className="text-sm mt-1">{ad.description}</p>
                    </div>
                  )}

                  {(ad.fileUrl || isExternalVideo) && (
                    <div>
                      <label className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Creative</label>
                      <div className="mt-2 rounded-lg border border-border overflow-hidden bg-background">
                        {isExternalVideo && hasEmbed ? (
                          <div className="relative">
                            <div className="aspect-video">
                              <iframe
                                src={(ad as any).embedUrl}
                                className="w-full h-full"
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                allowFullScreen
                                title={ad.title}
                              />
                            </div>
                            <div className="p-3 border-t border-border flex items-center justify-between">
                              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                {(ad as any).videoProvider === "youtube" ? (
                                  <Youtube className="h-4 w-4 text-red-500" />
                                ) : (ad as any).videoProvider === "vimeo" ? (
                                  <Video className="h-4 w-4 text-blue-400" />
                                ) : (
                                  <Link2 className="h-4 w-4" />
                                )}
                                <span>{providerLabel}</span>
                                {(ad as any).videoAuthor && (
                                  <>
                                    <span className="text-border">·</span>
                                    <span>{(ad as any).videoAuthor}</span>
                                  </>
                                )}
                                {(ad as any).videoDuration && (
                                  <>
                                    <span className="text-border">·</span>
                                    <span>{(ad as any).videoDuration}</span>
                                  </>
                                )}
                              </div>
                              {(ad as any).sourceUrl && (
                                <a href={(ad as any).sourceUrl} target="_blank" rel="noreferrer" className="text-[11px] text-primary hover:underline flex items-center gap-1">
                                  <ExternalLink className="h-3 w-3" />Open original
                                </a>
                              )}
                            </div>
                          </div>
                        ) : isExternalVideo && (ad as any).thumbnailUrl ? (
                          <div className="relative">
                            <img src={(ad as any).thumbnailUrl} alt={ad.title} className="w-full h-auto" />
                            <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                              <div className="h-16 w-16 rounded-full bg-white/90 flex items-center justify-center">
                                <Video className="h-8 w-8 text-black ml-1" />
                              </div>
                            </div>
                          </div>
                        ) : ad.format === "image" && ad.fileUrl ? (
                          <img src={playableUrl} alt={ad.title} className="max-h-80 w-auto mx-auto" />
                        ) : ad.format === "video" && ad.fileUrl ? (
                          <video src={playableUrl} controls className="max-h-80 w-full" />
                        ) : ad.format === "audio" && ad.fileUrl ? (
                          <audio src={playableUrl} controls className="w-full p-4" />
                        ) : ad.fileUrl ? (
                          <a href={playableUrl} target="_blank" rel="noreferrer" className="block p-4 text-sm text-primary hover:underline">View File</a>
                        ) : null}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-4">
                    <InfoField label="Target Audience" value={ad.targetAudience || "Not specified"} />
                    <InfoField label="Source" value={
                      ad.sourceType === "youtube" ? "YouTube" :
                      ad.sourceType === "vimeo" ? "Vimeo" :
                      ad.sourceType === "direct_url" ? "Direct URL" :
                      "File Upload"
                    } />
                    <InfoField label="File Name" value={ad.fileName || "—"} />
                    <InfoField label="Scheduled Start" value={ad.scheduledStart ? new Date(ad.scheduledStart).toLocaleDateString() : "—"} />
                    <InfoField label="Scheduled End" value={ad.scheduledEnd ? new Date(ad.scheduledEnd).toLocaleDateString() : "—"} />
                    {(ad as any).videoAuthor && <InfoField label="Video Author" value={(ad as any).videoAuthor} />}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Frame Analysis Tab */}
            <TabsContent value="frames">
              <div className="space-y-4">
                {/* Frame Analysis Summary */}
                {frameAnalysis?.status === "running" ? (
                  <Card className="bg-card border-border">
                    <CardContent className="p-8 text-center">
                      <Loader2 className="h-10 w-10 animate-spin text-primary mx-auto mb-3" />
                      <h3 className="font-semibold mb-1">Frame Analysis In Progress</h3>
                      <p className="text-sm text-muted-foreground">
                        Downloading video, extracting frames, and running AI vision analysis.
                        This can take several minutes for longer videos. Results will appear automatically.
                      </p>
                    </CardContent>
                  </Card>
                ) : frameAnalysis?.status === "failed" ? (
                  <Card className="bg-card border-red-500/20">
                    <CardContent className="p-6">
                      <div className="flex items-start gap-3">
                        <AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
                        <div className="flex-1">
                          <h3 className="font-semibold text-red-400 mb-1">Frame Analysis Failed</h3>
                          <p className="text-sm text-muted-foreground mb-3">
                            {frameAnalysis.summary || "The analysis encountered an error. Check server logs for details."}
                          </p>
                          <Button size="sm" variant="outline" onClick={() => runAiReview.mutate({ adId })} disabled={runAiReview.isPending}>
                              {runAiReview.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Zap className="h-3.5 w-3.5 mr-1.5" />}
                              Run AI Review
                            </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ) : frameAnalysis && frameAnalysis.status !== "pending" ? (
                  <>
                    {/* Summary Card */}
                    <Card className="bg-card border-border">
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between mb-4">
                          <div className="flex items-center gap-2">
                            <Film className="h-5 w-5 text-primary" />
                            <h3 className="font-semibold text-sm">Frame-by-Frame Analysis</h3>
                            <Badge variant={frameAnalysis.status === "completed" ? "default" : frameAnalysis.status === "failed" ? "destructive" : "secondary"} className="text-[10px]">
                              {frameAnalysis.status}
                            </Badge>
                          </div>
                          <Button variant="outline" size="sm" onClick={() => runAiReview.mutate({ adId })} disabled={runAiReview.isPending}>
                            {runAiReview.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Zap className="h-3.5 w-3.5 mr-1" />}
                            Re-analyze
                          </Button>
                        </div>

                        <div className="grid grid-cols-4 gap-3 mb-4">
                          <div className="p-3 rounded-lg bg-background border border-border/50 text-center">
                            <p className="text-2xl font-bold text-foreground">{frameAnalysis.totalFramesAnalyzed}</p>
                            <p className="text-[11px] text-muted-foreground">Frames Analyzed</p>
                          </div>
                          <div className="p-3 rounded-lg bg-background border border-border/50 text-center">
                            <p className={`text-2xl font-bold ${(frameAnalysis.overallVideoScore ?? 0) >= 80 ? "text-green-400" : (frameAnalysis.overallVideoScore ?? 0) >= 50 ? "text-yellow-400" : "text-red-400"}`}>
                              {frameAnalysis.overallVideoScore ?? "—"}
                            </p>
                            <p className="text-[11px] text-muted-foreground">Video Score</p>
                          </div>
                          <div className="p-3 rounded-lg bg-background border border-border/50 text-center">
                            <p className={`text-2xl font-bold ${frameAnalysis.flaggedFrameCount === 0 ? "text-green-400" : "text-red-400"}`}>
                              {frameAnalysis.flaggedFrameCount}
                            </p>
                            <p className="text-[11px] text-muted-foreground">Flagged Frames</p>
                          </div>
                          <div className="p-3 rounded-lg bg-background border border-border/50 text-center">
                            <p className="text-2xl font-bold text-foreground">{frameAnalysis.analysisIntervalSeconds}s</p>
                            <p className="text-[11px] text-muted-foreground">Interval</p>
                          </div>
                        </div>

                        {frameAnalysis.summary && (
                          <p className="text-sm text-muted-foreground">{frameAnalysis.summary}</p>
                        )}

                        {frameAnalysis.worstTimestamp && frameAnalysis.worstIssue && (
                          <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                            <div className="flex items-center gap-2 mb-1">
                              <TriangleAlert className="h-4 w-4 text-red-400" />
                              <span className="text-sm font-semibold text-red-400">Worst Issue at {frameAnalysis.worstTimestamp}</span>
                            </div>
                            <p className="text-sm text-muted-foreground">{frameAnalysis.worstIssue}</p>
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    {/* Frame Timeline */}
                    {frames.length > 0 && (
                      <Card className="bg-card border-border">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm font-semibold flex items-center gap-2">
                            <Clock className="h-4 w-4 text-primary" />
                            Frame Timeline
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="p-4">
                          {/* Visual Timeline Bar */}
                          <div className="mb-4">
                            <div className="relative h-10 bg-background rounded-lg border border-border overflow-hidden flex">
                              {frames.map((frame: any, idx: number) => {
                                const width = 100 / frames.length;
                                const bgColor = frame.severity === "safe" ? "bg-green-500/60" :
                                  frame.severity === "info" ? "bg-blue-500/60" :
                                  frame.severity === "warning" ? "bg-yellow-500/60" :
                                  frame.severity === "critical" ? "bg-red-500/60" :
                                  frame.severity === "blocking" ? "bg-red-700/80" :
                                  "bg-muted";
                                const isSelected = selectedFrame === idx;
                                return (
                                  <Tooltip key={idx}>
                                    <TooltipTrigger asChild>
                                      <button
                                        className={`relative h-full transition-all hover:brightness-125 ${bgColor} ${isSelected ? "ring-2 ring-primary ring-inset z-10" : ""}`}
                                        style={{ width: `${width}%` }}
                                        onClick={() => setSelectedFrame(isSelected ? null : idx)}
                                      >
                                        {(frame.severity === "critical" || frame.severity === "blocking") && (
                                          <div className="absolute inset-0 flex items-center justify-center">
                                            <TriangleAlert className="h-4 w-4 text-white drop-shadow-md" />
                                          </div>
                                        )}
                                      </button>
                                    </TooltipTrigger>
                                    <TooltipContent className="max-w-xs">
                                      <p className="font-semibold">{frame.timestampFormatted} — Score: {frame.score}/100</p>
                                      <p className="text-xs">{frame.description}</p>
                                    </TooltipContent>
                                  </Tooltip>
                                );
                              })}
                            </div>
                            <div className="flex justify-between mt-1">
                              <span className="text-[10px] text-muted-foreground">{frames[0]?.timestampFormatted || "0:00"}</span>
                              <span className="text-[10px] text-muted-foreground">{frames[frames.length - 1]?.timestampFormatted || ""}</span>
                            </div>
                          </div>

                          {/* Timeline Legend */}
                          <div className="flex items-center gap-4 mb-4 text-[11px] text-muted-foreground">
                            <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-green-500/60" /> Safe</span>
                            <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-blue-500/60" /> Info</span>
                            <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-yellow-500/60" /> Warning</span>
                            <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-red-500/60" /> Critical</span>
                            <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-red-700/80" /> Blocking</span>
                          </div>

                          {/* Selected Frame Detail */}
                          {selectedFrame !== null && frames[selectedFrame] && (
                            <FrameDetailCard frame={frames[selectedFrame]} index={selectedFrame} />
                          )}

                          {/* Flagged Frames Section */}
                          {flaggedFrames.length > 0 && (
                            <div className="mt-4">
                              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
                                <AlertTriangle className="h-3.5 w-3.5 text-red-400" />
                                Flagged Frames ({flaggedFrames.length})
                              </h4>
                              <div className="space-y-2">
                                {flaggedFrames.map((frame: any, idx: number) => {
                                  const originalIdx = frames.indexOf(frame);
                                  return (
                                    <button
                                      key={idx}
                                      className={`w-full text-left p-3 rounded-lg border transition-colors ${
                                        selectedFrame === originalIdx
                                          ? "bg-primary/10 border-primary/30"
                                          : "bg-background border-border/50 hover:border-border"
                                      }`}
                                      onClick={() => setSelectedFrame(originalIdx)}
                                    >
                                      <div className="flex items-center justify-between mb-1">
                                        <div className="flex items-center gap-2">
                                          <SeverityIcon severity={frame.severity} />
                                          <span className="text-sm font-medium">{frame.timestampFormatted}</span>
                                          <Badge variant="outline" className="text-[10px]">{frame.severity}</Badge>
                                        </div>
                                        <span className={`text-sm font-bold ${frame.score >= 80 ? "text-green-400" : frame.score >= 50 ? "text-yellow-400" : "text-red-400"}`}>
                                          {frame.score}/100
                                        </span>
                                      </div>
                                      <p className="text-xs text-muted-foreground line-clamp-2">{frame.description}</p>
                                      {frame.issues?.length > 0 && (
                                        <div className="flex flex-wrap gap-1 mt-1.5">
                                          {frame.issues.map((issue: any, iIdx: number) => (
                                            <Badge key={iIdx} variant="outline" className={`text-[10px] ${
                                              issue.severity === "critical" || issue.severity === "blocking"
                                                ? "border-red-500/30 text-red-400"
                                                : issue.severity === "warning"
                                                ? "border-yellow-500/30 text-yellow-400"
                                                : "border-blue-500/30 text-blue-400"
                                            }`}>
                                              {issue.category}
                                            </Badge>
                                          ))}
                                        </div>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {/* All Frames List */}
                          <div className="mt-4">
                            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
                              <Eye className="h-3.5 w-3.5" />
                              All Frames ({frames.length})
                            </h4>
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                              {frames.map((frame: any, idx: number) => (
                                <button
                                  key={idx}
                                  className={`relative rounded-lg border overflow-hidden transition-all ${
                                    selectedFrame === idx
                                      ? "ring-2 ring-primary border-primary"
                                      : "border-border/50 hover:border-border"
                                  }`}
                                  onClick={() => setSelectedFrame(idx)}
                                >
                                  {frame.thumbnailUrl ? (
                                    <img
                                      src={frame.thumbnailUrl}
                                      alt={`Frame at ${frame.timestampFormatted}`}
                                      className="w-full aspect-video object-cover"
                                    />
                                  ) : (
                                    <div className="w-full aspect-video bg-muted flex items-center justify-center">
                                      <Film className="h-6 w-6 text-muted-foreground" />
                                    </div>
                                  )}
                                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-1.5">
                                    <div className="flex items-center justify-between">
                                      <span className="text-[10px] text-white font-medium">{frame.timestampFormatted}</span>
                                      <span className={`text-[10px] font-bold ${
                                        frame.score >= 80 ? "text-green-400" : frame.score >= 50 ? "text-yellow-400" : "text-red-400"
                                      }`}>
                                        {frame.score}
                                      </span>
                                    </div>
                                  </div>
                                  {(frame.severity === "critical" || frame.severity === "blocking") && (
                                    <div className="absolute top-1 right-1">
                                      <TriangleAlert className="h-4 w-4 text-red-400 drop-shadow-md" />
                                    </div>
                                  )}
                                </button>
                              ))}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    )}
                  </>
                ) : (
                  <Card className="bg-card border-border">
                    <CardContent className="p-8 text-center">
                      <Film className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
                      <h3 className="font-semibold mb-1">Frame-by-Frame Analysis</h3>
                      <p className="text-sm text-muted-foreground mb-4">
                        {canRunFrameAnalysis
                          ? "Analyze individual frames of this video to identify exact timestamps of problematic content."
                          : "Frame analysis is available for video and image content."}
                      </p>
                      {canRunFrameAnalysis && (
                        <Button onClick={() => runAiReview.mutate({ adId })} disabled={runAiReview.isPending}>
                          {runAiReview.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Zap className="h-4 w-4 mr-2" />}
                          Run AI Review
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                )}
              </div>
            </TabsContent>

            {/* AI Analysis Tab */}
            <TabsContent value="ai">
              <div className="space-y-4">
                {/* ── Scores + Summary ─────────────────────────────────── */}
                <Card className="bg-card border-border">
                  <CardContent className="p-4">
                    {ad.status === "ai_screening" ? (
                    <div className="py-8 text-center">
                      <Loader2 className="h-10 w-10 animate-spin text-primary mx-auto mb-3" />
                      <h3 className="font-semibold mb-1">AI Review In Progress</h3>
                      {(() => {
                        const stages = ["stage1_running", "stage2_running", "stage3_running"];
                        const labels = ["Stage 1: Quick Scan", "Stage 2: Deep Analysis", "Stage 3: Generating Report"];
                        const descs = [
                          "Extracting keyframes and scanning for issues…",
                          "Running FCC/IAB compliance checks on flagged content…",
                          "Synthesizing findings and recommendation…",
                        ];
                        const idx = stages.indexOf(reviewStage ?? "");
                        const activeDesc = idx >= 0 ? descs[idx] : descs[0];
                        return (
                          <>
                            <p className="text-xs text-muted-foreground mb-3">{activeDesc}</p>
                            <div className="flex justify-center gap-3 text-xs">
                              {stages.map((s, i) => {
                                const past = idx > i;
                                const active = idx === i;
                                return (
                                  <div key={s} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border ${active ? "border-primary text-primary bg-primary/5" : past ? "border-green-500/50 text-green-400" : "border-border text-muted-foreground"}`}>
                                    {past ? <CircleCheck className="h-3 w-3" /> : active ? <Loader2 className="h-3 w-3 animate-spin" /> : <div className="h-3 w-3 rounded-full border border-current opacity-40" />}
                                    {labels[i]}
                                  </div>
                                );
                              })}
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  ) : aiAnalysisError ? (
                    <div className="py-8 text-center">
                      <div className="h-10 w-10 rounded-full bg-destructive/20 flex items-center justify-center mx-auto mb-3">
                        <span className="text-destructive text-xl font-bold">!</span>
                      </div>
                      <h3 className="font-semibold mb-1 text-destructive">AI Screening Failed</h3>
                      <p className="text-sm text-muted-foreground mb-3">
                        The analysis could not be completed. No score has been recorded.
                      </p>
                      <p className="text-xs font-mono bg-muted rounded px-3 py-2 text-left max-w-lg mx-auto break-all">
                        {aiAnalysisError}
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="mt-4"
                        onClick={() => runAiReview.mutate({ adId })}
                        disabled={runAiReview.isPending}
                      >
                        {runAiReview.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Zap className="h-3.5 w-3.5 mr-1.5" />}
                        Retry AI Review
                      </Button>
                    </div>
                  ) : aiAnalysis ? (
                      <div className="space-y-4">
                        {/* Moderator Brief — auto-generated in Stage 3 */}
                        {aiAnalysis.moderatorBrief && (
                          <div className="p-3 rounded-lg bg-primary/5 border border-primary/20">
                            <div className="flex items-center gap-2 mb-1.5">
                              <Bot className="h-4 w-4 text-primary" />
                              <span className="text-[11px] uppercase tracking-wider text-primary font-semibold">Moderator Brief</span>
                              {aiAnalysis.deepAnalysisTriggered === false && (
                                <Badge variant="outline" className="text-[10px] border-green-500/40 text-green-400">Quick scan only</Badge>
                              )}
                            </div>
                            <p className="text-sm leading-relaxed">{aiAnalysis.moderatorBrief}</p>
                          </div>
                        )}
                        {/* AI Agent Decision — routing reasoning */}
                        {aiAnalysis.routingDecision && (
                          <div className={`p-3 rounded-lg border ${
                            aiAnalysis.routingDecision === "auto_approve"
                              ? "bg-green-500/5 border-green-500/20"
                              : aiAnalysis.routingDecision === "auto_reject"
                              ? "bg-red-500/5 border-red-500/20"
                              : "bg-yellow-500/5 border-yellow-500/20"
                          }`}>
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <Zap className={`h-4 w-4 ${
                                  aiAnalysis.routingDecision === "auto_approve" ? "text-green-400" :
                                  aiAnalysis.routingDecision === "auto_reject" ? "text-red-400" :
                                  "text-yellow-400"
                                }`} />
                                <span className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">AI Agent Decision</span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <Badge variant="outline" className={`text-[10px] ${
                                  aiAnalysis.routingDecision === "auto_approve" ? "border-green-500/40 text-green-400" :
                                  aiAnalysis.routingDecision === "auto_reject" ? "border-red-500/40 text-red-400" :
                                  "border-yellow-500/40 text-yellow-400"
                                }`}>
                                  {aiAnalysis.routingDecision.replace(/_/g, " ")}
                                </Badge>
                                {aiAnalysis.skippedDeepAnalysis && (
                                  <Badge variant="outline" className="text-[10px] border-blue-500/30 text-blue-400">Quick scan only</Badge>
                                )}
                              </div>
                            </div>
                            {/* Confidence bar */}
                            <div className="mb-2">
                              <div className="flex justify-between mb-1">
                                <span className="text-[10px] text-muted-foreground">Confidence</span>
                                <span className={`text-[10px] font-bold ${
                                  (aiAnalysis.routingConfidence ?? 0) >= 85 ? "text-green-400" :
                                  (aiAnalysis.routingConfidence ?? 0) >= 60 ? "text-yellow-400" :
                                  "text-red-400"
                                }`}>{aiAnalysis.routingConfidence ?? aiAnalysis.confidence ?? 0}%</span>
                              </div>
                              <Progress
                                value={aiAnalysis.routingConfidence ?? aiAnalysis.confidence ?? 0}
                                className="h-1.5"
                              />
                            </div>
                            {/* Stages completed */}
                            {aiAnalysis.stagesCompleted?.length > 0 && (
                              <div className="flex items-center gap-1.5 mb-2">
                                <span className="text-[10px] text-muted-foreground">Stages:</span>
                                {[1, 2, 3].map(s => (
                                  <span key={s} className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                                    aiAnalysis.stagesCompleted.includes(s)
                                      ? "bg-primary/15 text-primary"
                                      : "bg-muted text-muted-foreground opacity-40"
                                  }`}>S{s}</span>
                                ))}
                              </div>
                            )}
                            {/* Routing reason */}
                            {aiAnalysis.routingReason && (
                              <p className="text-xs text-muted-foreground leading-relaxed">{aiAnalysis.routingReason}</p>
                            )}
                          </div>
                        )}

                        <div className="grid grid-cols-3 gap-3">
                          <ScoreCard label="Overall Score" score={ad.aiScore ?? 0} />
                          <ScoreCard label="Brand Safety" score={ad.brandSafetyScore ?? 0} />
                          <ScoreCard label="Confidence" score={aiAnalysis.confidence ?? 0} />
                        </div>
                        <div className="flex items-center gap-3">
                          <label className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Recommendation</label>
                          <Badge variant={aiAnalysis.recommendation === "auto_approve" ? "default" : aiAnalysis.recommendation === "auto_reject" ? "destructive" : "secondary"}>
                            {aiAnalysis.recommendation?.replace(/_/g, " ")}
                          </Badge>
                          {aiAnalysis.isPoliticalAd && (
                            <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30 flex items-center gap-1">
                              <Megaphone className="h-3 w-3" />Political Ad
                            </Badge>
                          )}
                        </div>
                        <div>
                          <label className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Summary</label>
                          <p className="text-sm mt-1">{aiAnalysis.summary}</p>
                        </div>
                        {aiAnalysis.contentCategories?.length > 0 && (
                          <div>
                            <label className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Content Categories</label>
                            <div className="flex flex-wrap gap-1.5 mt-1">
                              {aiAnalysis.contentCategories.map((cat: string) => (
                                <Badge key={cat} variant="outline" className="text-[11px]">{cat}</Badge>
                              ))}
                            </div>
                          </div>
                        )}
                        {aiAnalysis.details?.textAnalysis && (
                          <div>
                            <label className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Text Analysis</label>
                            <div className="mt-1 text-sm space-y-1">
                              <p>Sentiment: <span className="text-foreground">{aiAnalysis.details.textAnalysis.sentiment}</span></p>
                              <p>Tone: <span className="text-foreground">{aiAnalysis.details.textAnalysis.tone}</span></p>
                              {aiAnalysis.details.textAnalysis.flaggedPhrases?.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-1">
                                  <span className="text-muted-foreground">Flagged phrases:</span>
                                  {aiAnalysis.details.textAnalysis.flaggedPhrases.map((p: string, i: number) => (
                                    <Badge key={i} variant="outline" className="text-[10px] border-yellow-500/30 text-yellow-400">{p}</Badge>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-center py-8">
                        <Bot className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                        <p className="text-sm text-muted-foreground">No AI analysis yet. Run AI Screening to analyze this ad.</p>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {aiAnalysis && (
                  <>
                    {/* ── Content Intelligence ─────────────────────────── */}
                    <Card className="bg-card border-border">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-semibold flex items-center gap-2">
                          <Zap className="h-4 w-4 text-primary" />
                          Content Intelligence
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="p-4 space-y-4">

                        {/* Advertiser */}
                        <div className="grid grid-cols-2 gap-3">
                          <div className="p-3 rounded-lg bg-background border border-border/50">
                            <div className="flex items-center gap-1.5 mb-1">
                              <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Advertiser</span>
                            </div>
                            {aiAnalysis.detectedAdvertiser?.name ? (
                              <>
                                <p className="text-sm font-medium">{aiAnalysis.detectedAdvertiser.name}</p>
                                {aiAnalysis.detectedAdvertiser.industry && (
                                  <p className="text-[11px] text-muted-foreground">{aiAnalysis.detectedAdvertiser.industry}</p>
                                )}
                                <p className="text-[10px] text-muted-foreground mt-1">{aiAnalysis.detectedAdvertiser.confidence}% confidence</p>
                              </>
                            ) : (
                              <p className="text-sm text-muted-foreground">Not identified</p>
                            )}
                          </div>

                          {/* Languages */}
                          <div className="p-3 rounded-lg bg-background border border-border/50">
                            <div className="flex items-center gap-1.5 mb-1">
                              <Languages className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Languages</span>
                            </div>
                            {aiAnalysis.detectedLanguages?.length > 0 ? (
                              <div className="space-y-1">
                                {aiAnalysis.detectedLanguages.map((lang: any, i: number) => (
                                  <div key={i} className="flex items-center justify-between">
                                    <span className="text-sm">{lang.language}</span>
                                    <span className="text-[10px] text-muted-foreground">{lang.script} · {lang.confidence}%</span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-sm text-muted-foreground">Not detected</p>
                            )}
                          </div>
                        </div>

                        {/* Political Ad Details */}
                        {aiAnalysis.isPoliticalAd && aiAnalysis.politicalDetails && (
                          <div className="p-3 rounded-lg bg-orange-500/5 border border-orange-500/20">
                            <div className="flex items-center gap-1.5 mb-2">
                              <Megaphone className="h-3.5 w-3.5 text-orange-400" />
                              <span className="text-[11px] uppercase tracking-wider text-orange-400 font-semibold">Political Ad Detected</span>
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-sm">
                              {aiAnalysis.politicalDetails.candidate && (
                                <div><span className="text-muted-foreground">Candidate: </span>{aiAnalysis.politicalDetails.candidate}</div>
                              )}
                              {aiAnalysis.politicalDetails.party && (
                                <div><span className="text-muted-foreground">Party: </span>{aiAnalysis.politicalDetails.party}</div>
                              )}
                              {aiAnalysis.politicalDetails.issue && (
                                <div><span className="text-muted-foreground">Issue: </span>{aiAnalysis.politicalDetails.issue}</div>
                              )}
                              {aiAnalysis.politicalDetails.jurisdiction && (
                                <div><span className="text-muted-foreground">Jurisdiction: </span>{aiAnalysis.politicalDetails.jurisdiction}</div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Objectionable Content */}
                        {aiAnalysis.objectionalContent?.length > 0 && (
                          <div>
                            <div className="flex items-center gap-1.5 mb-2">
                              <AlertTriangle className="h-3.5 w-3.5 text-yellow-400" />
                              <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Regulated Content</span>
                            </div>
                            <div className="space-y-2">
                              {aiAnalysis.objectionalContent.map((item: any, i: number) => (
                                <div key={i} className={`p-2.5 rounded-lg border ${
                                  item.severity === "blocking" ? "bg-red-500/5 border-red-500/20" :
                                  item.severity === "critical" ? "bg-red-500/5 border-red-500/20" :
                                  item.severity === "warning" ? "bg-yellow-500/5 border-yellow-500/20" :
                                  "bg-blue-500/5 border-blue-500/20"
                                }`}>
                                  <div className="flex items-center justify-between mb-1">
                                    <div className="flex items-center gap-2">
                                      <SeverityIcon severity={item.severity} />
                                      <span className="text-xs font-semibold capitalize">{item.type.replace(/_/g, " ")}</span>
                                      <Badge variant="outline" className="text-[10px]">{item.severity}</Badge>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      {item.fccRelevant && <Badge variant="outline" className="text-[9px] border-blue-500/30 text-blue-400">FCC</Badge>}
                                      {item.iabRelevant && <Badge variant="outline" className="text-[9px] border-purple-500/30 text-purple-400">IAB</Badge>}
                                      <span className="text-[10px] text-muted-foreground">{item.confidence}%</span>
                                    </div>
                                  </div>
                                  <p className="text-xs text-muted-foreground">{item.description}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Flaggable Content */}
                        {aiAnalysis.flaggableContent?.length > 0 && (
                          <div>
                            <div className="flex items-center gap-1.5 mb-2">
                              <Flag className="h-3.5 w-3.5 text-red-400" />
                              <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Flaggable Content</span>
                            </div>
                            <div className="space-y-2">
                              {aiAnalysis.flaggableContent.map((item: any, i: number) => (
                                <div key={i} className={`p-2.5 rounded-lg border ${
                                  item.severity === "blocking" || item.severity === "critical"
                                    ? "bg-red-500/5 border-red-500/20"
                                    : item.severity === "warning"
                                    ? "bg-yellow-500/5 border-yellow-500/20"
                                    : "bg-blue-500/5 border-blue-500/20"
                                }`}>
                                  <div className="flex items-center justify-between mb-1">
                                    <div className="flex items-center gap-2">
                                      <SeverityIcon severity={item.severity} />
                                      <span className="text-xs font-semibold capitalize">{item.type.replace(/_/g, " ")}</span>
                                      <Badge variant="outline" className="text-[10px]">{item.severity}</Badge>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      {item.timestamp && (
                                        <Badge variant="outline" className="text-[10px] border-muted-foreground/30">
                                          <Clock className="h-2.5 w-2.5 mr-1" />{item.timestamp}
                                        </Badge>
                                      )}
                                      <span className="text-[10px] text-muted-foreground">{item.confidence}%</span>
                                    </div>
                                  </div>
                                  <p className="text-xs text-muted-foreground">{item.description}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Clean slate */}
                        {!aiAnalysis.objectionalContent?.length && !aiAnalysis.flaggableContent?.length && (
                          <div className="flex items-center gap-2 text-sm text-green-400 p-3 rounded-lg bg-green-500/5 border border-green-500/20">
                            <CircleCheck className="h-4 w-4" />
                            No objectionable or flaggable content detected.
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    {/* ── Audience Targeting Intelligence ──────────────── */}
                    {aiAnalysis.audienceDemographics && (
                      <Card className="bg-card border-border">
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm font-semibold flex items-center gap-2">
                            <Users className="h-4 w-4 text-primary" />
                            Audience Targeting Intelligence
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="p-4 space-y-5">

                          {/* Recommended Segments */}
                          {aiAnalysis.audienceDemographics.recommended?.length > 0 && (
                            <div>
                              <h4 className="text-xs font-semibold uppercase tracking-wider text-green-400 mb-2 flex items-center gap-1.5">
                                <CheckCircle className="h-3.5 w-3.5" />
                                Recommended Audiences
                              </h4>
                              <div className="space-y-2">
                                {aiAnalysis.audienceDemographics.recommended.map((seg: any, i: number) => (
                                  <div key={i} className="p-2.5 rounded-lg bg-green-500/5 border border-green-500/20">
                                    <div className="flex items-start justify-between gap-2">
                                      <div className="flex-1">
                                        <p className="text-sm font-medium">{seg.segment}</p>
                                        <p className="text-xs text-muted-foreground mt-0.5">{seg.reasoning}</p>
                                      </div>
                                      {seg.geographies?.length > 0 && (
                                        <div className="flex flex-wrap gap-1 shrink-0 max-w-[160px]">
                                          {seg.geographies.slice(0, 3).map((geo: string, gi: number) => (
                                            <Badge key={gi} variant="outline" className="text-[9px] border-green-500/30 text-green-400">
                                              <Globe className="h-2.5 w-2.5 mr-0.5" />{geo}
                                            </Badge>
                                          ))}
                                          {seg.geographies.length > 3 && (
                                            <Badge variant="outline" className="text-[9px]">+{seg.geographies.length - 3}</Badge>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Lookalike Advertisers */}
                          {aiAnalysis.audienceDemographics.lookalikAdvertisers?.length > 0 && (
                            <div>
                              <h4 className="text-xs font-semibold uppercase tracking-wider text-blue-400 mb-2 flex items-center gap-1.5">
                                <Building2 className="h-3.5 w-3.5" />
                                Lookalike Advertisers
                              </h4>
                              <div className="grid grid-cols-2 gap-2">
                                {aiAnalysis.audienceDemographics.lookalikAdvertisers.map((adv: any, i: number) => (
                                  <div key={i} className="p-2.5 rounded-lg bg-blue-500/5 border border-blue-500/20">
                                    <p className="text-sm font-medium">{adv.name}</p>
                                    <p className="text-[10px] text-muted-foreground">{adv.industry}</p>
                                    <p className="text-[11px] text-muted-foreground mt-1">{adv.similarity}</p>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Blocked Audiences */}
                          {aiAnalysis.audienceDemographics.blockedAudiences?.length > 0 && (
                            <div>
                              <h4 className="text-xs font-semibold uppercase tracking-wider text-red-400 mb-2 flex items-center gap-1.5">
                                <Ban className="h-3.5 w-3.5" />
                                Must Not Reach
                              </h4>
                              <div className="space-y-2">
                                {aiAnalysis.audienceDemographics.blockedAudiences.map((block: any, i: number) => (
                                  <div key={i} className={`p-2.5 rounded-lg border ${
                                    block.severity === "legal" ? "bg-red-500/5 border-red-500/30" :
                                    block.severity === "required" ? "bg-red-500/5 border-red-500/20" :
                                    "bg-yellow-500/5 border-yellow-500/20"
                                  }`}>
                                    <div className="flex items-start justify-between gap-2 mb-1">
                                      <div className="flex items-center gap-1.5">
                                        <Ban className={`h-3.5 w-3.5 shrink-0 ${
                                          block.severity === "legal" ? "text-red-400" :
                                          block.severity === "required" ? "text-red-400" :
                                          "text-yellow-400"
                                        }`} />
                                        <p className="text-sm font-medium">{block.segment}</p>
                                      </div>
                                      <Badge
                                        variant="outline"
                                        className={`text-[9px] shrink-0 ${
                                          block.severity === "legal" ? "border-red-500/40 text-red-400" :
                                          block.severity === "required" ? "border-red-500/30 text-red-300" :
                                          "border-yellow-500/30 text-yellow-400"
                                        }`}
                                      >
                                        {block.severity}
                                      </Badge>
                                    </div>
                                    <p className="text-xs text-muted-foreground">{block.reason}</p>
                                    {block.legalBasis && (
                                      <p className="text-[10px] text-muted-foreground mt-1 font-mono">{block.legalBasis}</p>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    )}

                    {/* ── FCC/IAB Compliance Scoring ──────────────────── */}
                    {aiAnalysis.complianceScores?.length > 0 && (
                      <>
                        <Card className="bg-card border-border">
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-semibold flex items-center gap-2">
                              <Shield className="h-4 w-4 text-primary" />
                              Regulatory Compliance Scores
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="p-4">
                            <div className="grid grid-cols-2 gap-4 mb-4">
                              <div className="rounded-lg border border-border p-4 text-center">
                                <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">FCC Compliance</p>
                                <p className={`text-3xl font-bold ${(aiAnalysis.overallFccScore ?? 0) >= 80 ? "text-green-400" : (aiAnalysis.overallFccScore ?? 0) >= 50 ? "text-yellow-400" : "text-red-400"}`}>
                                  {aiAnalysis.overallFccScore ?? "—"}
                                </p>
                                <p className="text-[10px] text-muted-foreground">/ 100</p>
                              </div>
                              <div className="rounded-lg border border-border p-4 text-center">
                                <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">IAB Compliance</p>
                                <p className={`text-3xl font-bold ${(aiAnalysis.overallIabScore ?? 0) >= 80 ? "text-green-400" : (aiAnalysis.overallIabScore ?? 0) >= 50 ? "text-yellow-400" : "text-red-400"}`}>
                                  {aiAnalysis.overallIabScore ?? "—"}
                                </p>
                                <p className="text-[10px] text-muted-foreground">/ 100</p>
                              </div>
                            </div>
                            {aiAnalysis.complianceSummary && (
                              <div className="mb-4 p-3 rounded-lg bg-background border border-border/50">
                                <label className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Compliance Summary</label>
                                <p className="text-sm mt-1">{aiAnalysis.complianceSummary}</p>
                              </div>
                            )}
                            {aiAnalysis.highestRiskArea && (
                              <div className="mb-4 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                                <div className="flex items-center gap-2 mb-1">
                                  <AlertTriangle className="h-3.5 w-3.5 text-red-400" />
                                  <label className="text-[11px] uppercase tracking-wider text-red-400 font-semibold">Highest Risk Area</label>
                                </div>
                                <p className="text-sm">{aiAnalysis.highestRiskArea}</p>
                              </div>
                            )}
                            {aiAnalysis.requiredActions?.length > 0 && (
                              <div className="p-3 rounded-lg bg-yellow-500/5 border border-yellow-500/20">
                                <label className="text-[11px] uppercase tracking-wider text-yellow-400 font-semibold">Required Actions Before Airing</label>
                                <div className="mt-2 space-y-1.5">
                                  {aiAnalysis.requiredActions.map((action: string, idx: number) => (
                                    <div key={idx} className="flex items-start gap-2">
                                      <span className="text-yellow-400 text-xs mt-0.5 font-bold">{idx + 1}.</span>
                                      <p className="text-sm">{action}</p>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </CardContent>
                        </Card>

                        <Card className="bg-card border-border">
                          <CardHeader className="pb-2">
                            <CardTitle className="text-sm font-semibold flex items-center gap-2">
                              <FileText className="h-4 w-4 text-primary" />
                              Category Breakdown
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="p-4">
                            {aiAnalysis.complianceScores.filter((cs: any) => cs.framework === "FCC").length > 0 && (
                              <div className="mb-6">
                                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
                                  <Shield className="h-3.5 w-3.5 text-blue-400" />FCC Broadcast Compliance
                                </h4>
                                <div className="space-y-3">
                                  {aiAnalysis.complianceScores.filter((cs: any) => cs.framework === "FCC").map((cs: any, idx: number) => (
                                    <ComplianceCategoryCard key={idx} category={cs} />
                                  ))}
                                </div>
                              </div>
                            )}
                            {aiAnalysis.complianceScores.filter((cs: any) => cs.framework === "IAB").length > 0 && (
                              <div>
                                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
                                  <Shield className="h-3.5 w-3.5 text-purple-400" />IAB Advertising Standards
                                </h4>
                                <div className="space-y-3">
                                  {aiAnalysis.complianceScores.filter((cs: any) => cs.framework === "IAB").map((cs: any, idx: number) => (
                                    <ComplianceCategoryCard key={idx} category={cs} />
                                  ))}
                                </div>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      </>
                    )}
                  </>
                )}
              </div>
            </TabsContent>

            {/* Reviews Tab */}
            <TabsContent value="reviews">
              <Card className="bg-card border-border">
                <CardContent className="p-4">
                  {ad.reviews && ad.reviews.length > 0 ? (
                    <div className="space-y-3">
                      {ad.reviews.map((review: any) => (
                        <div key={review.id} className="p-3 rounded-lg bg-background border border-border/50">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <DecisionIcon decision={review.decision} />
                              <span className="text-sm font-medium capitalize">{review.decision.replace("_", " ")}</span>
                            </div>
                            <span className="text-[11px] text-muted-foreground">{new Date(review.createdAt).toLocaleString()}</span>
                          </div>
                          {review.comments && <p className="text-sm text-muted-foreground">{review.comments}</p>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-8">No reviews yet.</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Violations Tab */}
            <TabsContent value="violations">
              <Card className="bg-card border-border">
                <CardContent className="p-4">
                  {ad.violations && ad.violations.length > 0 ? (
                    <div className="space-y-3">
                      {ad.violations.map((v: any) => (
                        <div key={v.id} className="p-3 rounded-lg bg-background border border-border/50">
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <SeverityIcon severity={v.severity} />
                              <span className="text-sm font-medium capitalize">{v.severity}</span>
                              <Badge variant="outline" className="text-[10px]">{v.detectedBy}</Badge>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge variant={v.status === "open" ? "destructive" : "secondary"} className="text-[10px]">{v.status}</Badge>
                              {v.status === "open" && (
                                <div className="flex gap-1">
                                  <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => resolveViolation.mutate({ id: v.id, status: "resolved" })}>Resolve</Button>
                                  <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => resolveViolation.mutate({ id: v.id, status: "dismissed" })}>Dismiss</Button>
                                </div>
                              )}
                            </div>
                          </div>
                          <p className="text-sm text-muted-foreground">{v.description}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-8">No violations detected.</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Approval Chain Tab */}
            <TabsContent value="approval">
              <Card className="bg-card border-border">
                <CardContent className="p-4">
                  {ad.approvalSteps && ad.approvalSteps.length > 0 ? (
                    <div className="space-y-3">
                      {ad.approvalSteps.map((step: any) => (
                        <div key={step.id} className="flex items-center gap-3 p-3 rounded-lg bg-background border border-border/50">
                          <div className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold ${
                            step.status === "approved" ? "bg-green-500/20 text-green-400" :
                            step.status === "rejected" ? "bg-red-500/20 text-red-400" :
                            "bg-muted text-muted-foreground"
                          }`}>
                            {step.stepNumber}
                          </div>
                          <div className="flex-1">
                            <p className="text-sm font-medium">{step.stepName || `Step ${step.stepNumber}`}</p>
                            <p className="text-[11px] text-muted-foreground">Required: {step.requiredRole}</p>
                          </div>
                          <Badge variant={step.status === "approved" ? "default" : step.status === "rejected" ? "destructive" : "secondary"} className="text-[10px]">
                            {step.status}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-8">No approval chain configured for this ad.</p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Approval Chain Progress */}
          {ad.approvalSteps && (ad.approvalSteps as any[]).length > 0 && (() => {
            const steps = ad.approvalSteps as any[];
            const current = (ad as any).currentApprovalStep ?? 0;
            const total = steps.length;
            const currentStepObj = steps.find((s: any) => s.stepNumber === current);
            return (
              <Card className="bg-card border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Shield className="h-4 w-4 text-primary" />
                    Approval Chain
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {current > 0 && currentStepObj && (
                    <div className="p-2.5 rounded-lg bg-primary/5 border border-primary/20 text-xs">
                      <span className="font-semibold">
                        Step {current} of {total}: {currentStepObj.stepName}
                      </span>
                      <span className="text-muted-foreground ml-1.5">
                        ({currentStepObj.requiredRole})
                      </span>
                    </div>
                  )}
                  <div className="space-y-2">
                    {steps.map((step: any) => {
                      const isPast = step.status === "approved" || step.status === "rejected";
                      const isActive = step.stepNumber === current && step.status === "pending";
                      return (
                        <div key={step.id} className="flex items-start gap-2.5">
                          <div className={`mt-0.5 h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                            step.status === "approved" ? "bg-green-500/20 text-green-400" :
                            step.status === "rejected" ? "bg-red-500/20 text-red-400" :
                            isActive ? "bg-primary/20 text-primary ring-1 ring-primary/40" :
                            "bg-muted text-muted-foreground"
                          }`}>
                            {step.status === "approved" ? <CircleCheck className="h-3 w-3" /> :
                             step.status === "rejected" ? <XCircle className="h-3 w-3" /> :
                             step.stepNumber}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className={`text-xs font-medium ${isActive ? "text-primary" : ""}`}>
                                {step.stepName || `Step ${step.stepNumber}`}
                              </span>
                              <Badge variant="outline" className="text-[9px] py-0">{step.requiredRole}</Badge>
                            </div>
                            {isPast && (
                              <p className="text-[11px] text-muted-foreground mt-0.5">
                                {step.status === "approved" ? "Approved" : "Rejected"}
                                {step.decidedByEmail ? ` by ${step.decidedByEmail}` : ""}
                                {step.decidedAt ? ` on ${new Date(step.decidedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
                              </p>
                            )}
                            {isActive && (
                              <p className="text-[11px] text-primary/70 mt-0.5">Awaiting review</p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {/* Review Panel */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Submit Review</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                placeholder="Add review comments..."
                value={reviewComment}
                onChange={e => setReviewComment(e.target.value)}
                className="text-sm bg-background min-h-[80px]"
              />
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white" onClick={() => handleReview("approve")} disabled={submitReview.isPending}>
                  <CheckCircle className="h-3.5 w-3.5 mr-1" />Approve
                </Button>
                <Button size="sm" variant="destructive" onClick={() => handleReview("reject")} disabled={submitReview.isPending}>
                  <XCircle className="h-3.5 w-3.5 mr-1" />Reject
                </Button>
                <Button size="sm" variant="outline" onClick={() => handleReview("request_changes")} disabled={submitReview.isPending}>
                  <MessageSquare className="h-3.5 w-3.5 mr-1" />Changes
                </Button>
                <Button size="sm" variant="outline" className="border-orange-500/50 text-orange-400 hover:bg-orange-500/10" onClick={() => handleReview("escalate")} disabled={submitReview.isPending}>
                  <AlertTriangle className="h-3.5 w-3.5 mr-1" />Escalate
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* AI Assistant — moderator brief auto-generated by Run AI Review */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Bot className="h-4 w-4 text-primary" />
                Moderator Brief
              </CardTitle>
            </CardHeader>
            <CardContent>
              {aiAnalysis?.moderatorBrief ? (
                <p className="text-sm leading-relaxed">{aiAnalysis.moderatorBrief}</p>
              ) : ad.status === "ai_screening" ? (
                <p className="text-sm text-muted-foreground">Generating…</p>
              ) : (
                <p className="text-sm text-muted-foreground">Run AI Review to generate a moderator brief.</p>
              )}
            </CardContent>
          </Card>

          {/* Frame Analysis Quick View */}
          {frameAnalysis && frameAnalysis.status === "completed" && (
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Film className="h-4 w-4 text-primary" />
                  Frame Analysis
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Frames</span>
                  <span className="font-medium">{frameAnalysis.totalFramesAnalyzed}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Video Score</span>
                  <span className={`font-medium ${(frameAnalysis.overallVideoScore ?? 0) >= 80 ? "text-green-400" : (frameAnalysis.overallVideoScore ?? 0) >= 50 ? "text-yellow-400" : "text-red-400"}`}>
                    {frameAnalysis.overallVideoScore}/100
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Flagged</span>
                  <span className={`font-medium ${frameAnalysis.flaggedFrameCount === 0 ? "text-green-400" : "text-red-400"}`}>
                    {frameAnalysis.flaggedFrameCount}
                  </span>
                </div>
                {frameAnalysis.worstTimestamp && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Worst At</span>
                    <span className="font-medium text-red-400">{frameAnalysis.worstTimestamp}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Info */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <InfoRow label="Format" value={ad.format} />
              <InfoRow label="Source" value={
                ad.sourceType === "youtube" ? "YouTube" :
                ad.sourceType === "vimeo" ? "Vimeo" :
                ad.sourceType === "direct_url" ? "Direct URL" :
                "Upload"
              } />
              <InfoRow label="Priority" value={ad.priority} />
              <InfoRow label="AI Score" value={ad.aiScore !== null ? `${ad.aiScore}/100` : "—"} />
              <InfoRow label="Brand Safety" value={ad.brandSafetyScore !== null ? `${ad.brandSafetyScore}/100` : "—"} />
              <InfoRow label="Created" value={new Date(ad.createdAt).toLocaleDateString()} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ─── Frame Detail Card ──────────────────────────────────────────────────────

function FrameDetailCard({ frame, index }: { frame: any; index: number }) {
  return (
    <div className="p-4 rounded-lg bg-background border border-primary/20 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <SeverityIcon severity={frame.severity} />
          <h4 className="font-semibold text-sm">Frame at {frame.timestampFormatted}</h4>
          <Badge variant="outline" className="text-[10px]">{frame.severity}</Badge>
        </div>
        <span className={`text-lg font-bold ${frame.score >= 80 ? "text-green-400" : frame.score >= 50 ? "text-yellow-400" : "text-red-400"}`}>
          {frame.score}/100
        </span>
      </div>

      {frame.thumbnailUrl && (
        <img
          src={frame.thumbnailUrl}
          alt={`Frame at ${frame.timestampFormatted}`}
          className="w-full rounded-lg border border-border"
        />
      )}

      <p className="text-sm text-muted-foreground">{frame.description}</p>

      {frame.issues?.length > 0 && (
        <div className="space-y-2">
          <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Issues Found</h5>
          {frame.issues.map((issue: any, idx: number) => (
            <div key={idx} className={`p-2.5 rounded-lg border ${
              issue.severity === "critical" || issue.severity === "blocking"
                ? "bg-red-500/5 border-red-500/20"
                : issue.severity === "warning"
                ? "bg-yellow-500/5 border-yellow-500/20"
                : "bg-blue-500/5 border-blue-500/20"
            }`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <SeverityIcon severity={issue.severity} />
                  <span className="text-xs font-semibold capitalize">{issue.category}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">{issue.policyArea}</Badge>
                  <span className="text-[10px] text-muted-foreground">{issue.confidence}% confidence</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{issue.description}</p>
            </div>
          ))}
        </div>
      )}

      {frame.issues?.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-green-400">
          <CircleCheck className="h-4 w-4" />
          No issues detected in this frame
        </div>
      )}
    </div>
  );
}

// ─── Shared Components ──────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: "bg-muted text-muted-foreground",
    submitted: "bg-blue-500/15 text-blue-400",
    ai_screening: "bg-purple-500/15 text-purple-400",
    ai_failed: "bg-red-500/15 text-red-400",
    in_review: "bg-yellow-500/15 text-yellow-400",
    escalated: "bg-orange-500/15 text-orange-400",
    approved: "bg-green-500/15 text-green-400",
    rejected: "bg-red-500/15 text-red-400",
  };
  return <Badge variant="outline" className={`text-[11px] ${colors[status] || ""}`}>{status.replace(/_/g, " ")}</Badge>;
}

function ScoreCard({ label, score }: { label: string; score: number }) {
  const color = score >= 80 ? "text-green-400" : score >= 50 ? "text-yellow-400" : "text-red-400";
  return (
    <div className="p-3 rounded-lg bg-background border border-border/50 text-center">
      <p className={`text-2xl font-bold ${color}`}>{score}</p>
      <p className="text-[11px] text-muted-foreground mt-0.5">{label}</p>
    </div>
  );
}

function DecisionIcon({ decision }: { decision: string }) {
  if (decision === "approve") return <CheckCircle className="h-4 w-4 text-green-400" />;
  if (decision === "reject") return <XCircle className="h-4 w-4 text-red-400" />;
  if (decision === "escalate") return <AlertTriangle className="h-4 w-4 text-orange-400" />;
  return <MessageSquare className="h-4 w-4 text-yellow-400" />;
}

function SeverityIcon({ severity }: { severity: string }) {
  if (severity === "blocking") return <XCircle className="h-4 w-4 text-red-400" />;
  if (severity === "critical") return <AlertTriangle className="h-4 w-4 text-red-400" />;
  if (severity === "warning") return <AlertTriangle className="h-4 w-4 text-yellow-400" />;
  if (severity === "safe") return <CircleCheck className="h-4 w-4 text-green-400" />;
  return <Info className="h-4 w-4 text-blue-400" />;
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</label>
      <p className="text-sm mt-0.5">{value}</p>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium capitalize">{value}</span>
    </div>
  );
}

// ─── Compliance Category Card ────────────────────────────────────────────────

function ComplianceCategoryCard({ category }: { category: any }) {
  const [expanded, setExpanded] = useState(false);
  const statusColor = category.status === "pass" ? "text-green-400 border-green-500/20 bg-green-500/5"
    : category.status === "warning" ? "text-yellow-400 border-yellow-500/20 bg-yellow-500/5"
    : "text-red-400 border-red-500/20 bg-red-500/5";
  const barColor = category.status === "pass" ? "bg-green-500"
    : category.status === "warning" ? "bg-yellow-500"
    : "bg-red-500";
  const frameworkColor = category.framework === "FCC" ? "text-blue-400 border-blue-500/30" : "text-purple-400 border-purple-500/30";

  return (
    <div className={`rounded-lg border p-3 transition-colors ${expanded ? statusColor : "border-border/50 bg-background"}`}>
      <button className="w-full text-left" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-sm font-medium truncate">{category.categoryName}</span>
            <Badge variant="outline" className={`text-[9px] shrink-0 ${frameworkColor}`}>{category.framework}</Badge>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant="outline" className={`text-[10px] capitalize ${
              category.status === "pass" ? "border-green-500/30 text-green-400" :
              category.status === "warning" ? "border-yellow-500/30 text-yellow-400" :
              "border-red-500/30 text-red-400"
            }`}>{category.status}</Badge>
            <span className={`text-lg font-bold ${
              category.score >= 80 ? "text-green-400" : category.score >= 50 ? "text-yellow-400" : "text-red-400"
            }`}>{category.score}</span>
          </div>
        </div>
        <div className="w-full bg-background rounded-full h-1.5 overflow-hidden">
          <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${category.score}%` }} />
        </div>
      </button>

      {expanded && category.findings?.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-border/50 pt-3">
          {category.findings.map((finding: any, idx: number) => (
            <div key={idx} className={`p-2.5 rounded-lg border ${
              finding.severity === "blocking" || finding.severity === "critical"
                ? "bg-red-500/5 border-red-500/15"
                : finding.severity === "warning"
                ? "bg-yellow-500/5 border-yellow-500/15"
                : "bg-blue-500/5 border-blue-500/15"
            }`}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <SeverityIcon severity={finding.severity} />
                  <span className="text-xs font-semibold">{finding.ruleName}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[9px] font-mono">{finding.ruleId}</Badge>
                  <span className="text-[10px] text-muted-foreground">{finding.confidence}%</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground mb-1">{finding.description}</p>
              {finding.recommendation && (
                <p className="text-xs text-primary/80">
                  <span className="font-semibold">Recommendation:</span> {finding.recommendation}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {expanded && (!category.findings || category.findings.length === 0) && (
        <div className="mt-3 pt-3 border-t border-border/50 flex items-center gap-2 text-sm text-green-400">
          <CircleCheck className="h-4 w-4" />
          No findings — fully compliant
        </div>
      )}
    </div>
  );
}
