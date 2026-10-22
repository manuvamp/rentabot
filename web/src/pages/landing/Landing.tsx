import { BotShelf } from './BotShelf'
import { ExampleJobs } from './ExampleJobs'
import { Hero } from './Hero'
import { HowItWorks } from './HowItWorks'
import { LiveStrip } from './LiveStrip'
import { MadeByBots } from './MadeByBots'
import { Doors, Faq, FooterCta } from './Tail'

export default function Landing() {
  return (
    <div id="top">
      <Hero />
      <LiveStrip />
      <MadeByBots />
      <ExampleJobs />
      <HowItWorks />
      <BotShelf />
      <Doors />
      <Faq />
      <FooterCta />
    </div>
  )
}
