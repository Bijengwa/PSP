import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useShopCategories } from './api'
import { IconArrow, IconCheck, IconDocument, IconImage, IconShield, IconTruck, IconWrench } from './Icons'

// Sample photos from Wikimedia Commons, as in the design preview, until PSP's
// own photos replace them. Credits are shown at the end of the page.
const COMMONS = 'https://thumb.wikimedia.org/wikipedia/commons/thumb'
const PHOTO = {
  ct: `${COMMONS}/d/d5/Modern%C3%AD_v%C3%BDpo%C4%8Detn%C3%AD_tomografie_s_p%C5%99%C3%ADmo_digit%C3%A1ln%C3%AD_detekc%C3%AD_rentgenov%C3%A9ho_z%C3%A1%C5%99en%C3%AD.jpg/960px-Modern%C3%AD_v%C3%BDpo%C4%8Detn%C3%AD_tomografie_s_p%C5%99%C3%ADmo_digit%C3%A1ln%C3%AD_detekc%C3%AD_rentgenov%C3%A9ho_z%C3%A1%C5%99en%C3%AD.jpg`,
  monitor: `${COMMONS}/9/95/Dash_5000_Medical_monitor.jpg/960px-Dash_5000_Medical_monitor.jpg`,
  microscope: `${COMMONS}/a/a3/Dark_Cool_Optical_Microscope.png/960px-Dark_Cool_Optical_Microscope.png`,
  bed: `${COMMONS}/1/10/Caretex25syasin.jpg/960px-Caretex25syasin.jpg`,
  oxygen: 'https://upload.wikimedia.org/wikipedia/commons/f/f3/Zen-O_portable_oxygen_concentrator.jpeg',
  infusion: `${COMMONS}/7/7e/Baxter_Colleague_CX_infusion_pump.JPG/960px-Baxter_Colleague_CX_infusion_pump.JPG`,
  autoclave: `${COMMONS}/3/37/2540EAP-B-L.jpg/960px-2540EAP-B-L.jpg`,
  dental: `${COMMONS}/2/28/001964_-_Colombia.jpg/960px-001964_-_Colombia.jpg`,
}

// Category tiles come from the API (only categories with live products); the
// photo is chosen by slug. Slugs match product_categories.
const CATEGORY_PHOTOS: Record<string, string> = {
  imaging: PHOTO.ct,
  'patient-monitoring': PHOTO.monitor,
  laboratory: PHOTO.microscope,
  'hospital-furniture': PHOTO.bed,
  respiratory: PHOTO.oxygen,
  infusion: PHOTO.infusion,
  sterilization: PHOTO.autoclave,
  dental: PHOTO.dental,
}

const SERVICES: { icon: ReactNode; title: string; text: string }[] = [
  { icon: <IconCheck size={22} />, title: 'Live stock', text: 'Availability updates as we sell and restock' },
  { icon: <IconTruck size={22} />, title: 'Nationwide delivery', text: 'To hospitals and clinics in every region' },
  { icon: <IconWrench size={22} />, title: 'Installation and training', text: 'Our engineers set up and train your staff' },
  { icon: <IconShield size={22} />, title: 'Warranty and service', text: 'After-sales support on every device' },
]

const CREDITS = [
  ['CT scanner', 'Tomáš Vendiš', 'CC BY-SA 4.0', 'Modern%C3%AD_v%C3%BDpo%C4%8Detn%C3%AD_tomografie_s_p%C5%99%C3%ADmo_digit%C3%A1ln%C3%AD_detekc%C3%AD_rentgenov%C3%A9ho_z%C3%A1%C5%99en%C3%AD.jpg'],
  ['Patient monitor', 'Stefan Bellini', 'CC BY-SA 3.0', 'Dash_5000_Medical_monitor.jpg'],
  ['Microscope', 'Rouibi Dhia Eddine Nadjm', 'CC BY-SA 4.0', 'Dark_Cool_Optical_Microscope.png'],
  ['Hospital bed', 'Wawakaka21', 'CC BY-SA 4.0', 'Caretex25syasin.jpg'],
  ['Oxygen concentrator', 'Donaldoleforo', 'CC BY-SA 4.0', 'Zen-O_portable_oxygen_concentrator.jpeg'],
  ['Infusion pump', 'BrokenSphere', 'CC BY-SA 3.0', 'Baxter_Colleague_CX_infusion_pump.JPG'],
  ['Autoclave', 'Evaporation Expert', 'CC BY-SA 4.0', '2540EAP-B-L.jpg'],
  ['Dental chair', 'M.Peinado', 'CC BY 2.0', '001964_-_Colombia.jpg'],
]

function HomeCategories() {
  const { loading, categories, error, retry } = useShopCategories()

  if (loading) {
    return (
      <ul className="shop-categories" aria-busy="true" aria-label="Loading categories">
        {Array.from({ length: 4 }, (_, index) => (
          <li key={index}>
            <span className="shop-category shop-category-skeleton" aria-hidden="true">
              <span className="shop-category-photo shop-skeleton-block" />
              <span className="shop-category-name">
                <span className="shop-skeleton-line" />
              </span>
            </span>
          </li>
        ))}
      </ul>
    )
  }

  if (error) {
    return (
      <div className="shop-state shop-state-inline" role="alert">
        <p>{error}</p>
        <button type="button" className="shop-button shop-button-secondary" onClick={retry}>
          Try again
        </button>
      </div>
    )
  }

  if (categories.length === 0) {
    return (
      <div className="shop-state shop-state-inline">
        <p>Our online catalogue is being updated. Contact us for prices and availability.</p>
        <Link to="/#contact" className="shop-button shop-button-secondary">
          Contact us
        </Link>
      </div>
    )
  }

  return (
    <ul className="shop-categories">
      {categories.map((category) => {
        const photo = CATEGORY_PHOTOS[category.slug]
        return (
          <li key={category.slug}>
            <Link to={`/products?category=${category.slug}`} className="shop-category">
              <span className="shop-category-photo">
                {photo ? (
                  <img src={photo} alt="" loading="lazy" decoding="async" />
                ) : (
                  <span className="shop-card-noimage">
                    <IconImage size={32} />
                  </span>
                )}
              </span>
              <span className="shop-category-name">
                {category.name}
                <span className="shop-category-count">
                  {category.productCount} {category.productCount === 1 ? 'product' : 'products'}
                </span>
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

export default function ShopHome() {
  return (
    <>
      <section className="shop-container shop-hero-section" aria-labelledby="hero-title">
        <div className="shop-hero">
          <div className="shop-hero-copy">
            <span className="shop-eyebrow">MEDICAL EQUIPMENT IMPORTER · TANZANIA</span>
            <h1 id="hero-title">Hospital-grade equipment, in stock in Dar es Salaam.</h1>
            <p>
              Patient monitors, diagnostics, respiratory care, hospital furniture and laboratory equipment. See live
              stock, order online, or request a quotation for your facility.
            </p>
            <div className="shop-hero-actions">
              <Link to="/products" className="shop-button shop-button-primary">
                Browse products
                <IconArrow />
              </Link>
              <Link to="/#contact" className="shop-button shop-button-quote">
                <IconDocument />
                Request a quotation
              </Link>
            </div>
          </div>

          <div className="shop-hero-visual">
            <img src={PHOTO.ct} alt="CT scanner in a hospital imaging room" loading="eager" decoding="async" />
            <div className="shop-hero-card">
              <div className="shop-hero-card-top">
                <span className="shop-hero-card-meta">Imaging · Large equipment</span>
                <span className="shop-pill shop-pill-quote">
                  <IconDocument size={14} />
                  Price on request
                </span>
              </div>
              <span className="shop-hero-card-title">CT and X-ray systems</span>
              <span className="shop-hero-card-text">
                Installation, training and service included. Pricing for your facility on request.
              </span>
              <Link to="/#contact" className="shop-hero-card-link">
                Request a quotation
                <IconArrow size={16} />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section id="services" className="shop-container shop-services" aria-label="Our services">
        {SERVICES.map((service) => (
          <div key={service.title} className="shop-service">
            <span className="shop-service-icon">{service.icon}</span>
            <span className="shop-service-text">
              <b>{service.title}</b>
              <span>{service.text}</span>
            </span>
          </div>
        ))}
      </section>

      <section id="categories" className="shop-container shop-section" aria-labelledby="categories-title">
        <h2 id="categories-title">Shop by category</h2>
        <HomeCategories />
      </section>

      <p className="shop-container shop-credits">
        Sample photos from Wikimedia Commons:{' '}
        {CREDITS.map(([label, author, licence, file], index) => (
          <span key={file}>
            {index > 0 && ' · '}
            <a href={`https://commons.wikimedia.org/wiki/File:${file}`} target="_blank" rel="noreferrer">
              {label}
            </a>{' '}
            by {author} ({licence})
          </span>
        ))}
      </p>
    </>
  )
}
