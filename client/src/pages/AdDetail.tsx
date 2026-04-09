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
  Globe, Languages, Flag, Users, Ban, Building2, Megaphone, Zap, ChevronDown,
  Sparkles,
} from "lucide-react";
import { useState, useMemo, useEffect, type ReactNode } from "react";
import { useLocation, useParams } from "wouter";
import { toast } from "sonner";

export default function AdDetail() {
  const params = useParams<{ id: string }>();
  const adId = parseInt(params.id || "0");
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const utils = trpc.useUtils();

  const [geminiRunning, setGeminiRunning] = useState(false);
  const [geminiAnalysisId, setGeminiAnalysisId] = useState<number | null>(null);

  // Poll while AI review is running, frame analysis is extracting, or Gemini analysis is in flight
  const { data: ad, isLoading } = trpc.ads.getById.useQuery(
    { id: adId },
    { refetchInterval: (data: any) => (data?.status === "ai_screening" || geminiRunning) ? 2500 : false }
  );
  const { data: frameAnalysis, isLoading: frameLoading } = trpc.ads.getFrameAnalysis.useQuery(
    { adId },
    { refetchInterval: (data: any) => (data?.status === "running" || geminiRunning) ? 2500 : false }
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
  const runGeminiAnalysis = trpc.ads.runGeminiAnalysis.useMutation({
    onSuccess: (data) => {
      setGeminiRunning(true);
      setGeminiAnalysisId(data.analysisId);
      utils.ads.getFrameAnalysis.invalidate({ adId });
      toast.info("Gemini analysis started — results will appear automatically");
    },
    onError: (e) => toast.error(`Gemini analysis failed: ${e.message}`),
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

  // Stop polling once Gemini results appear in aiAnalysis, or when the record fails
  const geminiAnalysis = (ad?.aiAnalysis as any)?.geminiAnalysis;
  useEffect(() => {
    if (!geminiRunning) return;
    if (geminiAnalysis) {
      setGeminiRunning(false);
      setGeminiAnalysisId(null);
      toast.success("Gemini analysis complete");
      return;
    }
    // Detect failure: the frameAnalysis record we started has transitioned to "failed"
    if (
      frameAnalysis &&
      (geminiAnalysisId === null || (frameAnalysis as any).id === geminiAnalysisId) &&
      (frameAnalysis as any).status === "failed"
    ) {
      setGeminiRunning(false);
      setGeminiAnalysisId(null);
      const summary: string = (frameAnalysis as any).summary ?? "";
      // Extract a short human-readable reason from the summary
      const reason = summary.includes("429") || summary.includes("quota")
        ? "Gemini quota exceeded — enable billing at aistudio.google.com"
        : summary.replace("Gemini analysis failed: ", "").slice(0, 120);
      toast.error(`Gemini analysis failed: ${reason}`);
    }
  }, [geminiAnalysis, geminiRunning, frameAnalysis, geminiAnalysisId]);

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
  const clearanceScore: number = aiAnalysis?.clearanceScore ?? ad.aiScore ?? 0;
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
          {ad.format === "video" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => runGeminiAnalysis.mutate({ adId })}
              disabled={runGeminiAnalysis.isPending || geminiRunning}
            >
              {geminiRunning || runGeminiAnalysis.isPending
                ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                : <Sparkles className="h-4 w-4 mr-1.5" />}
              Gemini Analysis
            </Button>
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
                                  <Video className="h-4 w-4 text-blue-600" />
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
                  <Card className="bg-card border-red-200">
                    <CardContent className="p-6">
                      <div className="flex items-start gap-3">
                        <AlertTriangle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
                        <div className="flex-1">
                          <h3 className="font-semibold text-red-600 mb-1">Frame Analysis Failed</h3>
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
                            <p className={`text-2xl font-bold ${(frameAnalysis.overallVideoScore ?? 0) >= 80 ? "text-green-600" : (frameAnalysis.overallVideoScore ?? 0) >= 50 ? "text-amber-600" : "text-red-600"}`}>
                              {frameAnalysis.overallVideoScore ?? "—"}
                            </p>
                            <p className="text-[11px] text-muted-foreground">Video Score</p>
                          </div>
                          <div className="p-3 rounded-lg bg-background border border-border/50 text-center">
                            <p className={`text-2xl font-bold ${frameAnalysis.flaggedFrameCount === 0 ? "text-green-600" : "text-red-600"}`}>
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
                          <div className="mt-3 p-3 rounded-lg bg-red-500/15 border border-red-200">
                            <div className="flex items-center gap-2 mb-1">
                              <TriangleAlert className="h-4 w-4 text-red-600" />
                              <span className="text-sm font-semibold text-red-600">Worst Issue at {frameAnalysis.worstTimestamp}</span>
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
                                <AlertTriangle className="h-3.5 w-3.5 text-red-600" />
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
                                        <span className={`text-sm font-bold ${frame.score >= 80 ? "text-green-600" : frame.score >= 50 ? "text-amber-600" : "text-red-600"}`}>
                                          {frame.score}/100
                                        </span>
                                      </div>
                                      <p className="text-xs text-muted-foreground line-clamp-2">{frame.description}</p>
                                      {frame.issues?.length > 0 && (
                                        <div className="flex flex-wrap gap-1 mt-1.5">
                                          {frame.issues.map((issue: any, iIdx: number) => (
                                            <Badge key={iIdx} variant="outline" className={`text-[10px] ${
                                              issue.severity === "critical" || issue.severity === "blocking"
                                                ? "border-red-300 text-red-600"
                                                : issue.severity === "warning"
                                                ? "border-amber-300 text-amber-600"
                                                : "border-blue-200 text-blue-600"
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
                                        frame.score >= 80 ? "text-green-600" : frame.score >= 50 ? "text-amber-600" : "text-red-600"
                                      }`}>
                                        {frame.score}
                                      </span>
                                    </div>
                                  </div>
                                  {(frame.severity === "critical" || frame.severity === "blocking") && (
                                    <div className="absolute top-1 right-1">
                                      <TriangleAlert className="h-4 w-4 text-red-600 drop-shadow-md" />
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
              <div className="space-y-3">
                {/* ── TIER 1: Clearance Score Hero / Loading / Error / Empty ── */}
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
                                    <div key={s} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border ${active ? "border-primary text-primary bg-primary/5" : past ? "border-green-400 text-green-600" : "border-border text-muted-foreground"}`}>
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
                      <div className="flex items-start gap-5">
                        {/* Big clearance score */}
                        <div className="text-center shrink-0 min-w-[88px]">
                          <p className={`text-7xl font-black leading-none tabular-nums ${
                            clearanceScore >= 80 ? "text-green-600" :
                            clearanceScore >= 50 ? "text-amber-600" :
                            "text-red-600"
                          }`}>{clearanceScore}</p>
                          <p className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1.5 font-semibold">Clearance</p>
                          {aiAnalysis.runNumber && (
                            <span className="text-[9px] text-muted-foreground/60 font-mono">Run #{aiAnalysis.runNumber}</span>
                          )}
                        </div>
                        {/* Routing details */}
                        <div className="flex-1 space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            {aiAnalysis.routingDecision && (
                              <Badge className={`text-xs px-2.5 py-0.5 ${
                                aiAnalysis.routingDecision === "auto_approve"
                                  ? "bg-green-100 text-green-600 border border-green-300"
                                  : aiAnalysis.routingDecision === "auto_reject"
                                  ? "bg-red-100 text-red-600 border border-red-300"
                                  : "bg-yellow-50 text-yellow-700 border border-yellow-300"
                              }`}>
                                <Zap className="h-3 w-3 mr-1" />
                                {aiAnalysis.routingDecision === "auto_approve" ? "Auto-Approved" :
                                 aiAnalysis.routingDecision === "auto_reject" ? "Auto-Rejected" :
                                 "Routed to Review"}
                              </Badge>
                            )}
                            {aiAnalysis.skippedDeepAnalysis && (
                              <Badge variant="outline" className="text-[10px] border-blue-200 text-blue-600">Quick scan only</Badge>
                            )}
                            {aiAnalysis.isPoliticalAd && (
                              <Badge className="bg-orange-100 text-orange-600 border border-orange-300 text-[10px]">
                                <Megaphone className="h-2.5 w-2.5 mr-1" />Political
                              </Badge>
                            )}
                          </div>
                          {aiAnalysis.routingReason && (
                            <p className="text-sm text-muted-foreground leading-relaxed">{aiAnalysis.routingReason}</p>
                          )}
                          <div className="flex items-center gap-3">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[11px] text-muted-foreground">Confidence</span>
                              <span className={`text-[11px] font-bold ${
                                (aiAnalysis.routingConfidence ?? aiAnalysis.confidence ?? 0) >= 85 ? "text-green-600" :
                                (aiAnalysis.routingConfidence ?? aiAnalysis.confidence ?? 0) >= 60 ? "text-amber-600" :
                                "text-red-600"
                              }`}>{aiAnalysis.routingConfidence ?? aiAnalysis.confidence ?? 0}%</span>
                            </div>
                            {aiAnalysis.stagesCompleted?.length > 0 && (
                              <div className="flex items-center gap-1">
                                {[1, 2, 3].map((s: number) => (
                                  <span key={s} className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                                    aiAnalysis.stagesCompleted.includes(s)
                                      ? "bg-primary/15 text-primary"
                                      : "bg-muted text-muted-foreground opacity-40"
                                  }`}>S{s}</span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="text-center py-8">
                        <Bot className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                        <p className="text-sm text-muted-foreground">No AI analysis yet. Run AI Screening to analyze this ad.</p>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {aiAnalysis && ad.status !== "ai_screening" && !aiAnalysisError && (
                  <>
                    {/* ── Previous Runs History ─────────────────────────── */}
                    {Array.isArray(aiAnalysis.previousRuns) && aiAnalysis.previousRuns.length > 0 && (
                      <AiAccordion
                        title={`Previous Runs`}
                        icon={<Clock className="h-4 w-4" />}
                        badge={<Badge variant="outline" className="text-[9px] ml-2">{aiAnalysis.previousRuns.length} earlier</Badge>}
                      >
                        <div className="space-y-2">
                          {[...(aiAnalysis.previousRuns as any[])].reverse().map((run: any, i: number) => (
                            <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border/50">
                              <div className="flex items-center gap-3">
                                <span className="text-[10px] font-mono text-muted-foreground">
                                  Run #{aiAnalysis.previousRuns.length - i}
                                </span>
                                <span className={`text-lg font-bold tabular-nums ${
                                  (run.clearanceScore ?? 0) >= 80 ? "text-green-600" :
                                  (run.clearanceScore ?? 0) >= 50 ? "text-amber-600" : "text-red-600"
                                }`}>{run.clearanceScore ?? "—"}</span>
                                {run.routingDecision && (
                                  <Badge variant="outline" className={`text-[9px] ${
                                    run.routingDecision === "auto_approve" ? "border-green-300 text-green-600" :
                                    run.routingDecision === "auto_reject"  ? "border-red-300 text-red-600" :
                                                                             "border-amber-300 text-amber-600"
                                  }`}>
                                    {run.routingDecision === "auto_approve" ? "Approved" :
                                     run.routingDecision === "auto_reject"  ? "Rejected" : "Needs Review"}
                                  </Badge>
                                )}
                              </div>
                              {run.archivedAt && (
                                <span className="text-[10px] text-muted-foreground">
                                  {new Date(run.archivedAt).toLocaleDateString()} {new Date(run.archivedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </AiAccordion>
                    )}

                    {/* ── TIER 2: Moderator Brief ───────────────────────── */}
                    {aiAnalysis.moderatorBrief && (
                      <Card className="bg-card border-border">
                        <CardContent className="p-4">
                          <div className="flex items-center gap-2 mb-2">
                            <Bot className="h-4 w-4 text-primary" />
                            <span className="text-[11px] uppercase tracking-wider text-primary font-semibold">Moderator Brief</span>
                          </div>
                          <p className="text-sm leading-relaxed">{aiAnalysis.moderatorBrief}</p>
                        </CardContent>
                      </Card>
                    )}

                    {/* ── TIER 3a: Regulatory Breakdown ─────────────────── */}
                    {aiAnalysis.complianceScores?.length > 0 && (
                      <AiAccordion
                        title="Regulatory Breakdown"
                        icon={<Shield className="h-4 w-4" />}
                        badge={
                          aiAnalysis.complianceScores.some((c: any) => c.status === "fail")
                            ? <Badge variant="outline" className="text-[10px] border-red-300 text-red-600 ml-2">Issues found</Badge>
                            : aiAnalysis.complianceScores.some((c: any) => c.status === "warning")
                            ? <Badge variant="outline" className="text-[10px] border-amber-300 text-amber-600 ml-2">Warnings</Badge>
                            : aiAnalysis.skippedDeepAnalysis
                            ? <Badge variant="outline" className="text-[10px] border-muted-foreground/30 text-muted-foreground ml-2">Not evaluated</Badge>
                            : <Badge variant="outline" className="text-[10px] border-green-300 text-green-600 ml-2">All clear</Badge>
                        }
                      >
                        <div className="space-y-4">
                          {aiAnalysis.skippedDeepAnalysis && (
                            <div className="p-3 rounded-lg bg-muted/40 border border-border/60 flex items-start gap-2">
                              <Info className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                              <p className="text-[12px] text-muted-foreground leading-relaxed">
                                Full compliance analysis was not run — the quick scan passed with no flagged content.
                                Run AI Review again to perform a full FCC/IAB check.
                              </p>
                            </div>
                          )}
                          <div className="grid grid-cols-2 gap-4">
                            <div className="rounded-lg border border-border p-4 text-center">
                              <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">FCC Compliance</p>
                              {aiAnalysis.overallFccScore != null ? (
                                <>
                                  <p className={`text-3xl font-bold ${aiAnalysis.overallFccScore >= 80 ? "text-green-600" : aiAnalysis.overallFccScore >= 50 ? "text-amber-600" : "text-red-600"}`}>
                                    {aiAnalysis.overallFccScore}
                                  </p>
                                  <p className="text-[10px] text-muted-foreground">/ 100</p>
                                </>
                              ) : (
                                <>
                                  <p className="text-3xl font-bold text-muted-foreground">—</p>
                                  <p className="text-[10px] text-muted-foreground">not evaluated</p>
                                </>
                              )}
                            </div>
                            <div className="rounded-lg border border-border p-4 text-center">
                              <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">IAB Compliance</p>
                              {aiAnalysis.overallIabScore != null ? (
                                <>
                                  <p className={`text-3xl font-bold ${aiAnalysis.overallIabScore >= 80 ? "text-green-600" : aiAnalysis.overallIabScore >= 50 ? "text-amber-600" : "text-red-600"}`}>
                                    {aiAnalysis.overallIabScore}
                                  </p>
                                  <p className="text-[10px] text-muted-foreground">/ 100</p>
                                </>
                              ) : (
                                <>
                                  <p className="text-3xl font-bold text-muted-foreground">—</p>
                                  <p className="text-[10px] text-muted-foreground">not evaluated</p>
                                </>
                              )}
                            </div>
                          </div>
                          {aiAnalysis.complianceSummary && (
                            <div className="p-3 rounded-lg bg-background border border-border/50">
                              <label className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Compliance Summary</label>
                              <p className="text-sm mt-1">{aiAnalysis.complianceSummary}</p>
                            </div>
                          )}
                          {aiAnalysis.highestRiskArea && (
                            <div className="p-3 rounded-lg bg-red-50 border border-red-200">
                              <div className="flex items-center gap-2 mb-1">
                                <AlertTriangle className="h-3.5 w-3.5 text-red-600" />
                                <label className="text-[11px] uppercase tracking-wider text-red-600 font-semibold">Highest Risk Area</label>
                              </div>
                              <p className="text-sm">{aiAnalysis.highestRiskArea}</p>
                            </div>
                          )}
                          {aiAnalysis.requiredActions?.length > 0 && (
                            <div className="p-3 rounded-lg bg-amber-50 border border-amber-200">
                              <label className="text-[11px] uppercase tracking-wider text-amber-600 font-semibold">Required Actions Before Airing</label>
                              <div className="mt-2 space-y-1.5">
                                {aiAnalysis.requiredActions.map((action: string, idx: number) => (
                                  <div key={idx} className="flex items-start gap-2">
                                    <span className="text-amber-600 text-xs mt-0.5 font-bold">{idx + 1}.</span>
                                    <p className="text-sm">{action}</p>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                          {aiAnalysis.complianceScores.filter((cs: any) => cs.framework === "FCC").length > 0 && (
                            <div>
                              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
                                <Shield className="h-3.5 w-3.5 text-blue-600" />FCC Broadcast Compliance
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
                                <Shield className="h-3.5 w-3.5 text-purple-700" />IAB Advertising Standards
                              </h4>
                              <div className="space-y-3">
                                {aiAnalysis.complianceScores.filter((cs: any) => cs.framework === "IAB").map((cs: any, idx: number) => (
                                  <ComplianceCategoryCard key={idx} category={cs} />
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </AiAccordion>
                    )}

                    {/* ── TIER 3b: Visual Analysis ──────────────────────── */}
                    {(frameAnalysis || aiAnalysis.overallVideoScore != null) && (
                      <AiAccordion
                        title="Visual Analysis"
                        icon={<Film className="h-4 w-4" />}
                        badge={
                          (aiAnalysis.flaggedFrameCount ?? frameAnalysis?.flaggedFrameCount ?? 0) > 0
                            ? <Badge variant="outline" className="text-[10px] border-red-300 text-red-600 ml-2">{aiAnalysis.flaggedFrameCount ?? frameAnalysis?.flaggedFrameCount} flagged</Badge>
                            : null
                        }
                      >
                        <div className="space-y-3">
                          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                            <div className="rounded-lg border border-border p-3 text-center">
                              <p className={`text-2xl font-bold ${
                                (aiAnalysis.overallVideoScore ?? frameAnalysis?.overallVideoScore ?? 0) >= 80 ? "text-green-600" :
                                (aiAnalysis.overallVideoScore ?? frameAnalysis?.overallVideoScore ?? 0) >= 50 ? "text-amber-600" :
                                "text-red-600"
                              }`}>{aiAnalysis.overallVideoScore ?? frameAnalysis?.overallVideoScore ?? "—"}</p>
                              <p className="text-[10px] text-muted-foreground mt-0.5">Video Score</p>
                            </div>
                            <div className="rounded-lg border border-border p-3 text-center">
                              <p className="text-2xl font-bold">{aiAnalysis.totalFramesAnalyzed ?? frameAnalysis?.totalFramesAnalyzed ?? "—"}</p>
                              <p className="text-[10px] text-muted-foreground mt-0.5">Frames</p>
                            </div>
                            <div className="rounded-lg border border-border p-3 text-center">
                              <p className={`text-2xl font-bold ${(aiAnalysis.flaggedFrameCount ?? frameAnalysis?.flaggedFrameCount ?? 0) === 0 ? "text-green-600" : "text-red-600"}`}>
                                {aiAnalysis.flaggedFrameCount ?? frameAnalysis?.flaggedFrameCount ?? 0}
                              </p>
                              <p className="text-[10px] text-muted-foreground mt-0.5">Flagged</p>
                            </div>
                            <div className="rounded-lg border border-border p-3 text-center">
                              <p className="text-lg font-bold text-red-600 leading-tight">
                                {aiAnalysis.worstTimestamp ?? frameAnalysis?.worstTimestamp ?? "—"}
                              </p>
                              <p className="text-[10px] text-muted-foreground mt-0.5">Worst Frame</p>
                            </div>
                          </div>
                          {(aiAnalysis.frameSummary || frameAnalysis?.summary) && (
                            <p className="text-sm text-muted-foreground">{aiAnalysis.frameSummary || frameAnalysis?.summary}</p>
                          )}
                          {(aiAnalysis.worstIssue || frameAnalysis?.worstIssue) && (
                            <div className="p-2.5 rounded-lg bg-red-50 border border-red-200">
                              <div className="flex items-center gap-1.5 mb-1">
                                <TriangleAlert className="h-3.5 w-3.5 text-red-600" />
                                <span className="text-[11px] text-red-600 font-semibold uppercase tracking-wider">Worst Issue</span>
                              </div>
                              <p className="text-sm">{aiAnalysis.worstIssue || frameAnalysis?.worstIssue}</p>
                            </div>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-xs"
                            onClick={() => document.querySelector<HTMLButtonElement>('[value="frames"]')?.click()}
                          >
                            <Film className="h-3.5 w-3.5 mr-1.5" />View All Frames
                          </Button>
                        </div>
                      </AiAccordion>
                    )}

                    {/* ── TIER 3d: Gemini Native Video Analysis ─────────── */}
                    {ad.format === "video" && (
                      <GeminiSection
                        analysis={aiAnalysis?.geminiAnalysis}
                        isRunning={geminiRunning}
                        onRun={() => runGeminiAnalysis.mutate({ adId })}
                        isPending={runGeminiAnalysis.isPending}
                      />
                    )}

                    {/* ── TIER 3e: Whisper Transcript ───────────────────── */}
                    {ad.format === "video" && (aiAnalysis as any)?.whisperTranscript && (
                      <WhisperTranscriptSection
                        transcript={(aiAnalysis as any).whisperTranscript}
                        findings={(aiAnalysis as any)?.geminiAnalysis?.findings ?? []}
                      />
                    )}

                    {/* ── TIER 3f: Policy Findings (deterministic rules engine) ── */}
                    {Array.isArray(aiAnalysis.policyFindings) && aiAnalysis.policyFindings.length > 0 && (
                      <PolicyFindingsSection findings={aiAnalysis.policyFindings} />
                    )}

                    {/* ── TIER 3c: Content Intelligence ─────────────────── */}
                    <AiAccordion
                      title="Content Intelligence"
                      icon={<Zap className="h-4 w-4" />}
                      badge={
                        (aiAnalysis.objectionalContent?.length > 0 || aiAnalysis.flaggableContent?.length > 0)
                          ? <Badge variant="outline" className="text-[10px] border-amber-300 text-amber-600 ml-2">Flagged items</Badge>
                          : null
                      }
                    >
                      <div className="space-y-4">
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
                        {aiAnalysis.isPoliticalAd && aiAnalysis.politicalDetails && (
                          <div className="p-3 rounded-lg bg-orange-50 border border-orange-200">
                            <div className="flex items-center gap-1.5 mb-2">
                              <Megaphone className="h-3.5 w-3.5 text-orange-600" />
                              <span className="text-[11px] uppercase tracking-wider text-orange-600 font-semibold">Political Ad Detected</span>
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
                        {aiAnalysis.objectionalContent?.length > 0 && (
                          <div>
                            <div className="flex items-center gap-1.5 mb-2">
                              <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                              <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Regulated Content</span>
                            </div>
                            <div className="space-y-2">
                              {aiAnalysis.objectionalContent.map((item: any, i: number) => (
                                <div key={i} className={`p-2.5 rounded-lg border ${
                                  item.severity === "blocking" ? "bg-red-50 border-red-200" :
                                  item.severity === "critical" ? "bg-red-50 border-red-200" :
                                  item.severity === "warning" ? "bg-amber-50 border-amber-200" :
                                  "bg-blue-50 border-blue-200"
                                }`}>
                                  <div className="flex items-center justify-between mb-1">
                                    <div className="flex items-center gap-2">
                                      <SeverityIcon severity={item.severity} />
                                      <span className="text-xs font-semibold capitalize">{item.type.replace(/_/g, " ")}</span>
                                      <Badge variant="outline" className="text-[10px]">{item.severity}</Badge>
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      {item.fccRelevant && <Badge variant="outline" className="text-[9px] border-blue-200 text-blue-600">FCC</Badge>}
                                      {item.iabRelevant && <Badge variant="outline" className="text-[9px] border-purple-200 text-purple-700">IAB</Badge>}
                                      <span className="text-[10px] text-muted-foreground">{item.confidence}%</span>
                                    </div>
                                  </div>
                                  <p className="text-xs text-muted-foreground">{item.description}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {aiAnalysis.flaggableContent?.length > 0 && (
                          <div>
                            <div className="flex items-center gap-1.5 mb-2">
                              <Flag className="h-3.5 w-3.5 text-red-600" />
                              <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Flaggable Content</span>
                            </div>
                            <div className="space-y-2">
                              {aiAnalysis.flaggableContent.map((item: any, i: number) => (
                                <div key={i} className={`p-2.5 rounded-lg border ${
                                  item.severity === "blocking" || item.severity === "critical"
                                    ? "bg-red-50 border-red-200"
                                    : item.severity === "warning"
                                    ? "bg-amber-50 border-amber-200"
                                    : "bg-blue-50 border-blue-200"
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
                        {!aiAnalysis.objectionalContent?.length && !aiAnalysis.flaggableContent?.length && (
                          <div className="flex items-center gap-2 text-sm text-green-600 p-3 rounded-lg bg-green-50 border border-green-200">
                            <CircleCheck className="h-4 w-4" />
                            No objectionable or flaggable content detected.
                          </div>
                        )}
                        {/* Audience Demographics */}
                        {aiAnalysis.audienceDemographics && (
                          <div className="space-y-4 border-t border-border/50 pt-4">
                            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                              <Users className="h-3.5 w-3.5" />Audience Targeting
                            </h4>
                            {aiAnalysis.audienceDemographics.recommended?.length > 0 && (
                              <div>
                                <h5 className="text-xs font-semibold uppercase tracking-wider text-green-600 mb-2 flex items-center gap-1.5">
                                  <CheckCircle className="h-3.5 w-3.5" />Recommended Audiences
                                </h5>
                                <div className="space-y-2">
                                  {aiAnalysis.audienceDemographics.recommended.map((seg: any, i: number) => (
                                    <div key={i} className="p-2.5 rounded-lg bg-green-50 border border-green-200">
                                      <div className="flex items-start justify-between gap-2">
                                        <div className="flex-1">
                                          <p className="text-sm font-medium">{seg.segment}</p>
                                          <p className="text-xs text-muted-foreground mt-0.5">{seg.reasoning}</p>
                                        </div>
                                        {seg.geographies?.length > 0 && (
                                          <div className="flex flex-wrap gap-1 shrink-0 max-w-[160px]">
                                            {seg.geographies.slice(0, 3).map((geo: string, gi: number) => (
                                              <Badge key={gi} variant="outline" className="text-[9px] border-green-300 text-green-600">
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
                            {aiAnalysis.audienceDemographics.lookalikAdvertisers?.length > 0 && (
                              <div>
                                <h5 className="text-xs font-semibold uppercase tracking-wider text-blue-600 mb-2 flex items-center gap-1.5">
                                  <Building2 className="h-3.5 w-3.5" />Lookalike Advertisers
                                </h5>
                                <div className="grid grid-cols-2 gap-2">
                                  {aiAnalysis.audienceDemographics.lookalikAdvertisers.map((adv: any, i: number) => (
                                    <div key={i} className="p-2.5 rounded-lg bg-blue-50 border border-blue-200">
                                      <p className="text-sm font-medium">{adv.name}</p>
                                      <p className="text-[10px] text-muted-foreground">{adv.industry}</p>
                                      <p className="text-[11px] text-muted-foreground mt-1">{adv.similarity}</p>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {aiAnalysis.audienceDemographics.blockedAudiences?.length > 0 && (
                              <div>
                                <h5 className="text-xs font-semibold uppercase tracking-wider text-red-600 mb-2 flex items-center gap-1.5">
                                  <Ban className="h-3.5 w-3.5" />Must Not Reach
                                </h5>
                                <div className="space-y-2">
                                  {aiAnalysis.audienceDemographics.blockedAudiences.map((block: any, i: number) => (
                                    <div key={i} className={`p-2.5 rounded-lg border ${
                                      block.severity === "legal" ? "bg-red-50 border-red-300" :
                                      block.severity === "required" ? "bg-red-50 border-red-200" :
                                      "bg-amber-50 border-amber-200"
                                    }`}>
                                      <div className="flex items-start justify-between gap-2 mb-1">
                                        <div className="flex items-center gap-1.5">
                                          <Ban className={`h-3.5 w-3.5 shrink-0 ${
                                            block.severity === "legal" || block.severity === "required" ? "text-red-600" : "text-amber-600"
                                          }`} />
                                          <p className="text-sm font-medium">{block.segment}</p>
                                        </div>
                                        <Badge variant="outline" className={`text-[9px] shrink-0 ${
                                          block.severity === "legal" ? "border-red-400 text-red-600" :
                                          block.severity === "required" ? "border-red-300 text-red-600" :
                                          "border-amber-300 text-amber-600"
                                        }`}>{block.severity}</Badge>
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
                          </div>
                        )}
                        {aiAnalysis.details?.textAnalysis && (
                          <div className="border-t border-border/50 pt-4">
                            <label className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Text Analysis</label>
                            <div className="mt-1 text-sm space-y-1">
                              <p>Sentiment: <span className="text-foreground">{aiAnalysis.details.textAnalysis.sentiment}</span></p>
                              <p>Tone: <span className="text-foreground">{aiAnalysis.details.textAnalysis.tone}</span></p>
                              {aiAnalysis.details.textAnalysis.flaggedPhrases?.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-1">
                                  <span className="text-muted-foreground">Flagged phrases:</span>
                                  {aiAnalysis.details.textAnalysis.flaggedPhrases.map((p: string, i: number) => (
                                    <Badge key={i} variant="outline" className="text-[10px] border-amber-300 text-amber-600">{p}</Badge>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </AiAccordion>
                  </>
                )}

                {/* Gemini section shown for video ads even when no other AI analysis exists */}
                {ad.format === "video" && !aiAnalysis && ad.status !== "ai_screening" && (
                  <GeminiSection
                    analysis={geminiAnalysis}
                    isRunning={geminiRunning}
                    onRun={() => runGeminiAnalysis.mutate({ adId })}
                    isPending={runGeminiAnalysis.isPending}
                  />
                )}

                {/* Whisper transcript shown standalone when no full AI analysis exists */}
                {ad.format === "video" && !aiAnalysis && (ad?.aiAnalysis as any)?.whisperTranscript && (
                  <WhisperTranscriptSection
                    transcript={(ad.aiAnalysis as any).whisperTranscript}
                    findings={[]}
                  />
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
                            step.status === "approved" ? "bg-green-100 text-green-600" :
                            step.status === "rejected" ? "bg-red-100 text-red-600" :
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
          {/* Clearance Score */}
          {aiAnalysis && ad.status !== "ai_screening" && !aiAnalysisError && (
            <Card className="bg-card border-border">
              <CardContent className="p-4 text-center">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold mb-1">Clearance Score</p>
                <p className={`text-6xl font-black leading-none tabular-nums ${
                  clearanceScore >= 80 ? "text-green-600" :
                  clearanceScore >= 50 ? "text-amber-600" :
                  "text-red-600"
                }`}>{clearanceScore}</p>
                <p className="text-[11px] text-muted-foreground mt-1">/ 100</p>
                {aiAnalysis.routingDecision && (
                  <div className="mt-3">
                    <Badge className={`text-xs ${
                      aiAnalysis.routingDecision === "auto_approve"
                        ? "bg-green-100 text-green-600 border border-green-300"
                        : aiAnalysis.routingDecision === "auto_reject"
                        ? "bg-red-100 text-red-600 border border-red-300"
                        : "bg-yellow-50 text-yellow-700 border border-yellow-300"
                    }`}>
                      {aiAnalysis.routingDecision === "auto_approve" ? "Auto-Approved" :
                       aiAnalysis.routingDecision === "auto_reject" ? "Auto-Rejected" :
                       "Routed to Review"}
                    </Badge>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

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
                            step.status === "approved" ? "bg-green-100 text-green-600" :
                            step.status === "rejected" ? "bg-red-100 text-red-600" :
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
                <Button size="sm" variant="outline" className="border-orange-400 text-orange-600 hover:bg-orange-500/15" onClick={() => handleReview("escalate")} disabled={submitReview.isPending}>
                  <AlertTriangle className="h-3.5 w-3.5 mr-1" />Escalate
                </Button>
              </div>
            </CardContent>
          </Card>

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
              <InfoRow label="Clearance" value={ad.aiScore !== null ? `${ad.aiScore}/100` : "—"} />
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
        <span className={`text-lg font-bold ${frame.score >= 80 ? "text-green-600" : frame.score >= 50 ? "text-amber-600" : "text-red-600"}`}>
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
                ? "bg-red-50 border-red-200"
                : issue.severity === "warning"
                ? "bg-amber-50 border-amber-200"
                : "bg-blue-50 border-blue-200"
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
        <div className="flex items-center gap-2 text-sm text-green-600">
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
    submitted: "bg-blue-50 text-blue-600",
    ai_screening: "bg-purple-50 text-purple-700",
    ai_failed: "bg-red-100 text-red-600",
    in_review: "bg-amber-100 text-amber-600",
    escalated: "bg-orange-100 text-orange-600",
    approved: "bg-green-100 text-green-600",
    rejected: "bg-red-100 text-red-600",
  };
  return <Badge variant="outline" className={`text-[11px] ${colors[status] || ""}`}>{status.replace(/_/g, " ")}</Badge>;
}

function ScoreCard({ label, score }: { label: string; score: number }) {
  const color = score >= 80 ? "text-green-600" : score >= 50 ? "text-amber-600" : "text-red-600";
  return (
    <div className="p-3 rounded-lg bg-background border border-border/50 text-center">
      <p className={`text-2xl font-bold ${color}`}>{score}</p>
      <p className="text-[11px] text-muted-foreground mt-0.5">{label}</p>
    </div>
  );
}

function DecisionIcon({ decision }: { decision: string }) {
  if (decision === "approve") return <CheckCircle className="h-4 w-4 text-green-600" />;
  if (decision === "reject") return <XCircle className="h-4 w-4 text-red-600" />;
  if (decision === "escalate") return <AlertTriangle className="h-4 w-4 text-orange-600" />;
  return <MessageSquare className="h-4 w-4 text-amber-600" />;
}

function SeverityIcon({ severity }: { severity: string }) {
  if (severity === "blocking") return <XCircle className="h-4 w-4 text-red-600" />;
  if (severity === "critical") return <AlertTriangle className="h-4 w-4 text-red-600" />;
  if (severity === "warning") return <AlertTriangle className="h-4 w-4 text-amber-600" />;
  if (severity === "safe") return <CircleCheck className="h-4 w-4 text-green-600" />;
  return <Info className="h-4 w-4 text-blue-600" />;
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

// ─── AI Accordion ────────────────────────────────────────────────────────────

function AiAccordion({ title, icon, badge, children, defaultOpen = false }: {
  title: string;
  icon: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card className="bg-card border-border">
      <button className="w-full text-left" onClick={() => setOpen(!open)}>
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-primary">{icon}</span>
            <span className="text-sm font-semibold">{title}</span>
            {badge}
          </div>
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
        </div>
      </button>
      {open && (
        <CardContent className="px-4 pb-4 pt-0">
          <div className="border-t border-border/50 pt-4">
            {children}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ─── Gemini Native Analysis Section ─────────────────────────────────────────

function GeminiSection({ analysis, isRunning, onRun, isPending }: {
  analysis: any;
  isRunning: boolean;
  onRun: () => void;
  isPending: boolean;
}) {
  if (isRunning) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="p-8 text-center">
          <Loader2 className="h-10 w-10 animate-spin text-primary mx-auto mb-3" />
          <h3 className="font-semibold mb-1">Gemini Analysis In Progress</h3>
          <p className="text-sm text-muted-foreground">
            Gemini 2.5 Pro is reading the raw video and audio stream — listening for spoken disclaimers,
            audio violations, and temporal patterns that frame sampling misses. This takes 1–3 minutes.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!analysis) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="p-6 text-center">
          <Sparkles className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <h3 className="font-semibold mb-1">Gemini Native Video Analysis</h3>
          <p className="text-sm text-muted-foreground mb-4 max-w-md mx-auto">
            Gemini 2.5 Pro processes the raw video+audio stream natively — no frame sampling.
            It catches spoken disclaimers, audio loudness violations (CALM Act), profanity,
            and temporal context that the frame pipeline misses.
          </p>
          <Button size="sm" variant="outline" onClick={onRun} disabled={isPending}>
            {isPending
              ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              : <Sparkles className="h-3.5 w-3.5 mr-1.5" />}
            Run Gemini Analysis
          </Button>
        </CardContent>
      </Card>
    );
  }

  const findings: any[] = analysis.findings ?? [];
  const blockingCount = findings.filter((f: any) => f.severity === "blocking").length;
  const criticalCount = findings.filter((f: any) => f.severity === "critical").length;
  const warningCount = findings.filter((f: any) => f.severity === "warning").length;

  return (
    <AiAccordion
      title="Gemini Native Analysis"
      icon={<Sparkles className="h-4 w-4" />}
      defaultOpen={blockingCount > 0 || criticalCount > 0}
      badge={
        blockingCount > 0 || criticalCount > 0
          ? <Badge variant="outline" className="text-[10px] border-red-300 text-red-600 ml-2">{blockingCount + criticalCount} critical</Badge>
          : warningCount > 0
          ? <Badge variant="outline" className="text-[10px] border-amber-300 text-amber-600 ml-2">{warningCount} warning{warningCount !== 1 ? "s" : ""}</Badge>
          : <Badge variant="outline" className="text-[10px] border-green-300 text-green-600 ml-2">All clear</Badge>
      }
    >
      <div className="space-y-4">
        {/* FCC / IAB scores */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-border p-4 text-center">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">FCC Compliance</p>
            <p className={`text-3xl font-bold ${
              analysis.overallFccScore >= 80 ? "text-green-600" :
              analysis.overallFccScore >= 50 ? "text-amber-600" : "text-red-600"
            }`}>{analysis.overallFccScore}</p>
            <p className="text-[10px] text-muted-foreground">/ 100 · Gemini</p>
          </div>
          <div className="rounded-lg border border-border p-4 text-center">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">IAB Compliance</p>
            <p className={`text-3xl font-bold ${
              analysis.overallIabScore >= 80 ? "text-green-600" :
              analysis.overallIabScore >= 50 ? "text-amber-600" : "text-red-600"
            }`}>{analysis.overallIabScore}</p>
            <p className="text-[10px] text-muted-foreground">/ 100 · Gemini</p>
          </div>
        </div>

        {/* Summary */}
        {analysis.complianceSummary && (
          <div className="p-3 rounded-lg bg-background border border-border/50">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">Analysis Summary</p>
            <p className="text-sm">{analysis.complianceSummary}</p>
          </div>
        )}

        {/* Audio violations */}
        {analysis.audioViolations?.length > 0 && (
          <div className="p-3 rounded-lg bg-amber-50 border border-amber-200">
            <div className="flex items-center gap-2 mb-2">
              <Music className="h-3.5 w-3.5 text-amber-600" />
              <p className="text-[11px] uppercase tracking-wider text-amber-600 font-semibold">Audio Violations</p>
            </div>
            <div className="space-y-1">
              {analysis.audioViolations.map((v: string, i: number) => (
                <p key={i} className="text-sm text-muted-foreground">• {v}</p>
              ))}
            </div>
          </div>
        )}

        {/* Required actions */}
        {analysis.requiredActions?.length > 0 && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200">
            <p className="text-[11px] uppercase tracking-wider text-red-600 font-semibold mb-2">Required Actions Before Airing</p>
            <div className="space-y-1.5">
              {analysis.requiredActions.map((action: string, i: number) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-red-600 text-xs font-bold mt-0.5">{i + 1}.</span>
                  <p className="text-sm">{action}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Findings list */}
        {findings.length > 0 ? (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              Findings ({findings.length})
            </h4>
            <div className="space-y-2">
              {findings.map((finding: any, i: number) => (
                <div key={i} className={`p-3 rounded-lg border ${
                  finding.severity === "blocking" ? "bg-red-50 border-red-300" :
                  finding.severity === "critical" ? "bg-red-50 border-red-200" :
                  finding.severity === "warning"  ? "bg-amber-50 border-amber-200" :
                                                    "bg-blue-50 border-blue-200"
                }`}>
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <SeverityIcon severity={finding.severity} />
                      <span className="text-xs font-semibold">{finding.ruleName}</span>
                      <Badge variant="outline" className="text-[9px] font-mono">{finding.ruleId}</Badge>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {finding.timestampSeconds != null && (
                        <Badge variant="outline" className="text-[10px] border-muted-foreground/30">
                          <Clock className="h-2.5 w-2.5 mr-1" />
                          {Math.floor(finding.timestampSeconds / 60)}:{String(Math.floor(finding.timestampSeconds % 60)).padStart(2, "0")}
                        </Badge>
                      )}
                      <span className="text-[10px] text-muted-foreground">{finding.confidence}%</span>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mb-1.5">{finding.description}</p>
                  {finding.recommendation && (
                    <p className="text-xs text-primary/80">→ {finding.recommendation}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-green-600 p-3 rounded-lg bg-green-50 border border-green-200">
            <CircleCheck className="h-4 w-4" />
            No compliance violations detected by Gemini.
          </div>
        )}

        {/* Whisper transcript */}
        {analysis.transcript && (
          <TranscriptViewer
            transcript={analysis.transcript}
            findings={findings}
          />
        )}

        {/* Metadata footer */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground border-t border-border/50 pt-3">
          <span>Model: {analysis.modelVersion}</span>
          <span>·</span>
          <span>Source: {analysis.sourceType?.replace("_", " ")}</span>
          {analysis.transcript && (
            <>
              <span>·</span>
              <span>Transcript: {analysis.transcript.segments.length} segments ({analysis.transcript.language})</span>
            </>
          )}
          {analysis.analyzedAt && (
            <>
              <span>·</span>
              <span>Analyzed: {new Date(analysis.analyzedAt).toLocaleDateString()}</span>
            </>
          )}
          {analysis.durationMs && (
            <>
              <span>·</span>
              <span>{(analysis.durationMs / 1000).toFixed(0)}s analysis time</span>
            </>
          )}
        </div>
      </div>
    </AiAccordion>
  );
}

// ─── Whisper Transcript Viewer ────────────────────────────────────────────────

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function TranscriptViewer({
  transcript,
  findings,
}: {
  transcript: { segments: { start: number; end: number; text: string }[]; fullText: string; language: string; durationSeconds: number };
  findings: any[];
}) {
  const [expanded, setExpanded] = useState(false);

  // Build a set of seconds that have a finding nearby (±2s)
  const flaggedSeconds = new Set<number>();
  for (const f of findings) {
    if (f.timestampSeconds != null) {
      for (let i = -2; i <= 2; i++) flaggedSeconds.add(Math.round(f.timestampSeconds) + i);
    }
  }

  function isSegmentFlagged(seg: { start: number; end: number }): boolean {
    for (let t = Math.floor(seg.start); t <= Math.ceil(seg.end); t++) {
      if (flaggedSeconds.has(t)) return true;
    }
    return false;
  }

  return (
    <div className="rounded-lg border border-border/60 overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-3 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          <Languages className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Whisper Transcript
          </span>
          <Badge variant="outline" className="text-[9px]">
            {transcript.segments.length} segments · {formatTime(transcript.durationSeconds)}
          </Badge>
          {findings.some((f) => f.timestampSeconds != null) && (
            <Badge variant="outline" className="text-[9px] border-amber-300 text-amber-600">
              violations highlighted
            </Badge>
          )}
        </div>
        <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="max-h-72 overflow-y-auto p-3 space-y-1 bg-background/50">
          {transcript.segments.map((seg, i) => {
            const flagged = isSegmentFlagged(seg);
            return (
              <div
                key={i}
                className={`flex gap-2.5 rounded px-2 py-1 text-xs leading-relaxed ${
                  flagged ? "bg-amber-100 border border-amber-300" : "hover:bg-muted/40"
                }`}
              >
                <span className={`shrink-0 font-mono text-[10px] mt-0.5 ${flagged ? "text-amber-600" : "text-muted-foreground"}`}>
                  {formatTime(seg.start)}
                </span>
                <span className={flagged ? "text-yellow-800" : ""}>{seg.text}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Standalone Whisper Transcript Section ────────────────────────────────────

function WhisperTranscriptSection({
  transcript,
  findings,
}: {
  transcript: { segments: { start: number; end: number; text: string }[]; fullText: string; language: string; durationSeconds: number };
  findings: any[];
}) {
  const flaggedSeconds = new Set<number>();
  for (const f of findings) {
    if (f.timestampSeconds != null) {
      for (let i = -2; i <= 2; i++) flaggedSeconds.add(Math.round(f.timestampSeconds) + i);
    }
  }

  function isSegmentFlagged(seg: { start: number; end: number }): boolean {
    for (let t = Math.floor(seg.start); t <= Math.ceil(seg.end); t++) {
      if (flaggedSeconds.has(t)) return true;
    }
    return false;
  }

  return (
    <AiAccordion
      title="Whisper Transcript"
      icon={<Languages className="h-4 w-4" />}
      badge={
        <Badge variant="outline" className="text-[9px] ml-2">
          {transcript.segments.length} segments · {transcript.language} · {formatTime(transcript.durationSeconds)}
        </Badge>
      }
    >
      <div className="space-y-3">
        <div className="max-h-80 overflow-y-auto space-y-0.5 rounded-lg border border-border/50 bg-background/50 p-2">
          {transcript.segments.map((seg, i) => {
            const flagged = isSegmentFlagged(seg);
            return (
              <div
                key={i}
                className={`flex gap-2.5 rounded px-2 py-1 text-xs leading-relaxed ${
                  flagged ? "bg-amber-100 border border-amber-300" : "hover:bg-muted/40"
                }`}
              >
                <span className={`shrink-0 font-mono text-[10px] mt-0.5 w-10 ${flagged ? "text-amber-600" : "text-muted-foreground"}`}>
                  {formatTime(seg.start)}
                </span>
                <span className={flagged ? "text-yellow-800" : ""}>{seg.text}</span>
              </div>
            );
          })}
        </div>
        {findings.some((f) => f.timestampSeconds != null) && (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-200 border border-amber-400" />
            Highlighted segments overlap with Gemini violation timestamps
          </p>
        )}
      </div>
    </AiAccordion>
  );
}

// ─── Policy Findings Section (deterministic rules engine) ────────────────────

type RuleFinding = {
  ruleId: string;
  ruleName: string;
  framework: "FCC" | "IAB";
  status: "pass" | "fail" | "warning" | "not_evaluated";
  confidence: 100;
  severity: "info" | "warning" | "critical" | "blocking";
  description: string;
  evidenceIds: string[];
  recommendation?: string;
};

function PolicyFindingsSection({ findings }: { findings: RuleFinding[] }) {
  const fails = findings.filter(f => f.status === "fail");
  const warnings = findings.filter(f => f.status === "warning");
  const passes = findings.filter(f => f.status === "pass");

  const badge = fails.length > 0
    ? <Badge variant="outline" className="text-[10px] border-red-300 text-red-600 ml-2">{fails.length} violation{fails.length !== 1 ? "s" : ""}</Badge>
    : warnings.length > 0
    ? <Badge variant="outline" className="text-[10px] border-amber-300 text-amber-600 ml-2">{warnings.length} warning{warnings.length !== 1 ? "s" : ""}</Badge>
    : <Badge variant="outline" className="text-[10px] border-green-300 text-green-600 ml-2">All clear</Badge>;

  return (
    <AiAccordion
      title="Policy Findings"
      icon={<Shield className="h-4 w-4" />}
      badge={badge}
    >
      <div className="space-y-2">
        <p className="text-[11px] text-muted-foreground flex items-center gap-1.5 pb-1">
          <span className="inline-block w-2 h-2 rounded-full bg-blue-500/60" />
          Deterministic policy evaluation — confidence 100%, no AI uncertainty
        </p>

        {[...fails, ...warnings, ...passes].map(finding => {
          const isFail = finding.status === "fail";
          const isWarn = finding.status === "warning";
          const isPass = finding.status === "pass";

          const rowColor = isFail
            ? "border-red-200 bg-red-50"
            : isWarn
            ? "border-amber-200 bg-amber-50"
            : "border-border/40 bg-background";

          const statusIcon = isFail
            ? <XCircle className="h-3.5 w-3.5 text-red-600 shrink-0 mt-0.5" />
            : isWarn
            ? <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
            : <CheckCircle className="h-3.5 w-3.5 text-green-600 shrink-0 mt-0.5" />;

          const frameworkColor = finding.framework === "FCC"
            ? "text-blue-600 border-blue-200"
            : "text-purple-700 border-purple-200";

          const severityColor = finding.severity === "blocking"
            ? "text-red-600 border-red-300"
            : finding.severity === "critical"
            ? "text-orange-600 border-orange-300"
            : "text-amber-600 border-amber-300";

          return (
            <div key={finding.ruleId} className={`rounded-lg border p-3 ${rowColor}`}>
              <div className="flex items-start gap-2.5">
                {statusIcon}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap mb-1">
                    <span className="text-[11px] font-semibold text-foreground">{finding.ruleName}</span>
                    <Badge variant="outline" className={`text-[9px] px-1.5 ${frameworkColor}`}>{finding.framework}</Badge>
                    <Badge variant="outline" className={`text-[9px] px-1.5 font-mono ${frameworkColor}`}>{finding.ruleId}</Badge>
                    {(isFail || isWarn) && (
                      <Badge variant="outline" className={`text-[9px] px-1.5 ${severityColor}`}>{finding.severity}</Badge>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">{finding.description}</p>
                  {finding.recommendation && (
                    <p className="text-[11px] text-yellow-700 mt-1.5 flex items-start gap-1">
                      <span className="shrink-0 mt-0.5">→</span>
                      {finding.recommendation}
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </AiAccordion>
  );
}

// ─── Compliance Category Card ────────────────────────────────────────────────

function ComplianceCategoryCard({ category }: { category: any }) {
  const [expanded, setExpanded] = useState(false);
  const isSkipped = category.status === "skipped";
  const statusColor = isSkipped ? "text-muted-foreground border-border bg-muted/20"
    : category.status === "pass" ? "text-green-600 border-green-200 bg-green-50"
    : category.status === "warning" ? "text-amber-600 border-amber-200 bg-amber-50"
    : "text-red-600 border-red-200 bg-red-50";
  const barColor = isSkipped ? "bg-muted-foreground/30"
    : category.status === "pass" ? "bg-green-500"
    : category.status === "warning" ? "bg-yellow-500"
    : "bg-red-500";
  const frameworkColor = category.framework === "FCC" ? "text-blue-600 border-blue-200" : "text-purple-700 border-purple-200";

  return (
    <div className={`rounded-lg border p-3 transition-colors ${expanded && !isSkipped ? statusColor : "border-border/50 bg-background"}`}>
      <button className="w-full text-left" onClick={() => !isSkipped && setExpanded(!expanded)}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className={`text-sm font-medium truncate ${isSkipped ? "text-muted-foreground" : ""}`}>{category.categoryName}</span>
            <Badge variant="outline" className={`text-[9px] shrink-0 ${frameworkColor}`}>{category.framework}</Badge>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isSkipped ? (
              <span className="text-[11px] text-muted-foreground italic">Not evaluated — quick scan clean</span>
            ) : (
              <>
                <Badge variant="outline" className={`text-[10px] capitalize ${
                  category.status === "pass" ? "border-green-300 text-green-600" :
                  category.status === "warning" ? "border-amber-300 text-amber-600" :
                  "border-red-300 text-red-600"
                }`}>{category.status}</Badge>
                <span className={`text-lg font-bold ${
                  category.score >= 80 ? "text-green-600" : category.score >= 50 ? "text-amber-600" : "text-red-600"
                }`}>{category.score}</span>
              </>
            )}
          </div>
        </div>
        <div className="w-full bg-background rounded-full h-1.5 overflow-hidden">
          <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: isSkipped ? "0%" : `${category.score}%` }} />
        </div>
      </button>

      {expanded && !isSkipped && category.findings?.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-border/50 pt-3">
          {category.findings.map((finding: any, idx: number) => (
            <div key={idx} className={`p-2.5 rounded-lg border ${
              finding.severity === "blocking" || finding.severity === "critical"
                ? "bg-red-50 border-red-200"
                : finding.severity === "warning"
                ? "bg-amber-50 border-amber-200"
                : "bg-blue-50 border-blue-200"
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
        <div className="mt-3 pt-3 border-t border-border/50 flex items-center gap-2 text-sm text-green-600">
          <CircleCheck className="h-4 w-4" />
          No findings — fully compliant
        </div>
      )}
    </div>
  );
}
