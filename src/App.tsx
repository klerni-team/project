import {useEffect, useState} from 'react';
import {AppShell} from '@astryxdesign/core/AppShell';
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout';
import {VStack} from '@astryxdesign/core/Stack';
import {NavIcon} from '@astryxdesign/core/NavIcon';
import {SideNav, SideNavHeading, SideNavItem, SideNavSection} from '@astryxdesign/core/SideNav';
import {Tab, TabList} from '@astryxdesign/core/TabList';
import {useMediaQuery} from '@astryxdesign/core/hooks';
import {CalendarCheck, ChartColumn, Flame, Leaf, Settings, Sparkles, type LucideIcon} from 'lucide-react';
import {Today} from './screens/Today.tsx';
import {Habits} from './screens/Habits.tsx';
import {Agent} from './screens/Agent.tsx';
import {Week} from './screens/Week.tsx';
import {SettingsScreen} from './screens/Settings.tsx';

export type ScreenId = 'today' | 'habits' | 'agent' | 'week' | 'settings';

const NAV: {id: ScreenId; label: string; icon: LucideIcon}[] = [
  {id: 'today', label: 'Сегодня', icon: CalendarCheck},
  {id: 'habits', label: 'Привычки', icon: Flame},
  {id: 'agent', label: 'Агент', icon: Sparkles},
  {id: 'week', label: 'Неделя', icon: ChartColumn},
  {id: 'settings', label: 'Ещё', icon: Settings},
];

const isScreen = (v: string): v is ScreenId => NAV.some(n => n.id === v);
const screenFromHash = (): ScreenId => {
  const h = window.location.hash.slice(1);
  return isScreen(h) ? h : 'today';
};

/** Navigation callback shared by screens; `prompt` pre-fills the agent composer. */
export type Navigate = (screen: ScreenId, prompt?: string) => void;

export default function App() {
  const isDesktop = useMediaQuery('(min-width: 900px)');
  const [screen, setScreen] = useState<ScreenId>(screenFromHash);
  const [agentDraft, setAgentDraft] = useState('');

  useEffect(() => {
    const onHash = () => setScreen(screenFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate: Navigate = (next, prompt) => {
    if (prompt !== undefined) setAgentDraft(prompt);
    window.location.hash = next;
    setScreen(next);
  };

  const content = {
    today: <Today navigate={navigate} />,
    habits: <Habits />,
    agent: <Agent draft={agentDraft} onDraftConsumed={() => setAgentDraft('')} />,
    week: <Week navigate={navigate} />,
    settings: <SettingsScreen />,
  }[screen];

  if (isDesktop) {
    return (
      <AppShell
        height="fill"
        sideNav={
          <SideNav
            header={<SideNavHeading icon={<NavIcon icon={<Leaf size={16} />} />} heading="Привычки" />}>
            <SideNavSection title="Разделы" isHeaderHidden>
              {NAV.map(n => (
                <SideNavItem
                  key={n.id}
                  label={n.id === 'settings' ? 'Настройки' : n.label}
                  icon={n.icon}
                  isSelected={screen === n.id}
                  onClick={() => navigate(n.id)}
                />
              ))}
            </SideNavSection>
          </SideNav>
        }>
        {content}
      </AppShell>
    );
  }

  return (
    <AppShell height="fill" mobileNav={false} variant="surface">
      <Layout
        height="fill"
        padding={0}
        content={
          <LayoutContent padding={0} isScrollable={false}>
            {content}
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider label="Разделы">
            {/* Standalone iOS draws under the home indicator (viewport-fit=cover). */}
            <VStack style={{paddingBottom: 'env(safe-area-inset-bottom)'}}>
              <TabList value={screen} onChange={v => isScreen(v) && navigate(v)} layout="fill" size="lg">
                {NAV.map(n => (
                  <Tab key={n.id} value={n.id} label={n.label} isLabelHidden icon={<n.icon size={22} />} />
                ))}
              </TabList>
            </VStack>
          </LayoutFooter>
        }
      />
    </AppShell>
  );
}
