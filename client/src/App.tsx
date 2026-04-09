import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import Login from "@/pages/Login";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import DashboardLayout from "./components/DashboardLayout";
import Home from "./pages/Home";
import AdSubmissions from "./pages/AdSubmissions";
import AdDetail from "./pages/AdDetail";
import NewAd from "./pages/NewAd";
import ReviewQueue from "./pages/ReviewQueue";
import AiScreening from "./pages/AiScreening";
import Policies from "./pages/Policies";
import Violations from "./pages/Violations";
import ApprovalChains from "./pages/ApprovalChains";
import BrandSafety from "./pages/BrandSafety";
import Analytics from "./pages/Analytics";
import Team from "./pages/Team";
import Integrations from "./pages/Integrations";
import AuditLog from "./pages/AuditLog";
import Notifications from "./pages/Notifications";

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route>
        <DashboardLayout>
          <Switch>
            <Route path="/" component={Home} />
            <Route path="/ads" component={AdSubmissions} />
            <Route path="/ads/new" component={NewAd} />
            <Route path="/ads/:id" component={AdDetail} />
            <Route path="/review" component={ReviewQueue} />
            <Route path="/ai-screening" component={AiScreening} />
            <Route path="/policies" component={Policies} />
            <Route path="/violations" component={Violations} />
            <Route path="/approvals" component={ApprovalChains} />
            <Route path="/brand-safety" component={BrandSafety} />
            <Route path="/analytics" component={Analytics} />
            <Route path="/team" component={Team} />
            <Route path="/integrations" component={Integrations} />
            <Route path="/audit" component={AuditLog} />
            <Route path="/notifications" component={Notifications} />
            <Route path="/404" component={NotFound} />
            <Route component={NotFound} />
          </Switch>
        </DashboardLayout>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
